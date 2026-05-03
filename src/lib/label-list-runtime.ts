/**
 * `label list` runtime -- Phase 2 PLAN 02-09 Task 2, LBL-01.list.
 *
 * Read command. Lists issue labels either workspace-wide or scoped to one
 * team via `--team` (UUID, key, or name). Team-filter routing happens INLINE
 * via filter-heuristics (UUID_RE / TEAM_KEY_RE) -- NO 02-02 resolver dep.
 * Linear's `IssueLabelFilter.team` accepts `{ key: { eq } }` and
 * `{ name: { eq } }` natively.
 *
 *   --team <uuid>    -> filter: { team: { id:   { eq: <uuid>     } } }
 *   --team ENG       -> filter: { team: { key:  { eq: 'ENG'      } } }
 *   --team Engineer  -> filter: { team: { name: { eq: 'Engineer' } } }
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'label')
 *   3. parsePagination -> { first, after }
 *   4. Inline team-filter routing (if --team supplied)
 *   5. withFetchInterception(async () => withRateLimitRetry(client.issueLabels(...)))
 *   6. Hydrate lazy `label.team` and `label.parent` ONLY when projection
 *      references them.
 *   7. project + meta with pageInfo, opt-in complexity.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { TEAM_KEY_RE, UUID_RE } from '@/lib/filter-heuristics.js'

export interface LabelListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  /** Optional team filter (UUID, key, or name). */
  team?: string
}

export interface LabelListInput {
  flags: LabelListFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface LabelListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SdkLabelConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface LabelTeamFilter {
  team: { id?: { eq: string }; key?: { eq: string }; name?: { eq: string } }
}

export async function labelListRuntime(input: LabelListInput): Promise<LabelListOutput> {
  const config = (input.loadConfigOverride ?? loadConfig)()

  const envForResolver: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string } = {}
  if (input.env.LINEAR_WORKSPACE !== undefined) {
    envForResolver.LINEAR_WORKSPACE = input.env.LINEAR_WORKSPACE
  }
  if (input.env.LINEAR_API_KEY !== undefined) {
    envForResolver.LINEAR_API_KEY = input.env.LINEAR_API_KEY
  }
  const resolveFlags = input.flags.workspace ? { workspace: input.flags.workspace } : {}
  const resolved = resolveWorkspace({
    flags: resolveFlags,
    env: envForResolver,
    config,
  })

  const fields = parseFields(input.flags.fields ?? 'defaults', 'label')
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })

  let filter: LabelTeamFilter | undefined
  if (input.flags.team !== undefined && input.flags.team !== '') {
    filter = buildTeamFilter(input.flags.team)
  }

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const args: { first: number; after?: string; filter?: LabelTeamFilter } = { first }
    if (after !== undefined) args.after = after
    if (filter !== undefined) args.filter = filter

    const connection = (await withRateLimitRetry(
      () => client.issueLabels(args as unknown as Parameters<LinearClient['issueLabels']>[0]),
      input.retryOptsOverride,
    )) as unknown as SdkLabelConnection

    const projected = await Promise.all(
      connection.nodes.map(async (node) => {
        const hydrated = await hydrateForProjection(node, fields)
        return project(hydrated, fields)
      }),
    )

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      pageInfo: {
        hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
        endCursor: connection.pageInfo?.endCursor ?? null,
        hasPreviousPage: Boolean(connection.pageInfo?.hasPreviousPage),
        startCursor: connection.pageInfo?.startCursor ?? null,
      },
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data: projected, meta }
  })
}

function buildTeamFilter(t: string): LabelTeamFilter {
  if (UUID_RE.test(t)) return { team: { id: { eq: t } } }
  if (TEAM_KEY_RE.test(t)) return { team: { key: { eq: t.toUpperCase() } } }
  return { team: { name: { eq: t } } }
}

// -----------------------------------------------------------------------------
// Lazy-property hydration -- labels expose `team`, `parent`, `creator` as
// lazy promise getters. Hydrate ONLY when the projection spec references them.
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['team', 'parent', 'creator'])

async function hydrateForProjection(
  label: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(label)) {
      if (!RELATION_KEYS.has(k)) out[k] = label[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(label)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = label[k]
        hydrated[k] = await resolveLazy(value)
      }
    } else {
      hydrated[k] = label[k]
    }
  }
  return hydrated
}

function neededRelations(spec: ProjectionSpec): Set<string> {
  if (spec === FULL_PRESET) return new Set(RELATION_KEYS)
  const out = new Set<string>()
  for (const path of spec) {
    const head = path.split('.')[0]
    if (head && RELATION_KEYS.has(head)) out.add(head)
  }
  return out
}

async function resolveLazy(value: unknown): Promise<unknown> {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    return await (value as Promise<unknown>)
  }
  return value
}
