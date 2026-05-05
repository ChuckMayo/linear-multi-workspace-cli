/**
 * `cycle list` runtime -- Phase 2 PLAN 02-08 Task 1, CYC-01.list.
 *
 * Read command. Lists Linear cycles with optional --team filter. Without
 * --team, returns all cycles across teams the viewer can see (workspace-wide).
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'cycle')
 *   3. parsePagination -> { first, after }
 *   4. If --team supplied: resolveTeamId(client, ws, ref) -> teamId, then
 *      filter = { team: { id: { eq: teamId } } }.
 *   5. withFetchInterception(async () => withRateLimitRetry(client.cycles(...)))
 *   6. Lazy-hydrate `team` only when projection references it (defaults preset
 *      includes `team.key`).
 *   7. project + meta with pageInfo, opt-in complexity.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveTeamId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { validateAndMergeIncludes } from '@/lib/include-fragments.js'

export interface CycleListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  team?: string
  /** Phase 3: hydrate related entities in a single rawRequest round-trip */
  include?: string[]
}

export interface CycleListInput {
  flags: CycleListFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CycleListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SdkCycleConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface CycleFilter {
  team?: { id: { eq: string } }
}

export async function cycleListRuntime(input: CycleListInput): Promise<CycleListOutput> {
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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'cycle')
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  // Phase 3: branch on --include. Empty → unchanged Phase 2 typed-SDK call.
  const includes = input.flags.include ?? []
  if (includes.length > 0) {
    const fragmentText = validateAndMergeIncludes('cycle list', includes)
    const query = composeCycleListWithIncludes(fragmentText)

    return withFetchInterception(async () => {
      // BL-02 fix: resolve --team ref and thread it through as `filter`
      // on the rawRequest path. Without this, `cycle list --team ENG
      // --include issues` silently returned cycles from EVERY team the
      // viewer can see, not just ENG.
      let filter: CycleFilter | undefined
      if (input.flags.team !== undefined) {
        const workspaceKey = resolved.name ?? '_api-key-env_'
        const teamId = await resolveTeamId(
          client,
          workspaceKey,
          input.flags.team,
          input.retryOptsOverride,
        )
        filter = { team: { id: { eq: teamId } } }
      }

      const vars: { first: number; after?: string; filter?: CycleFilter } = { first }
      if (after !== undefined) vars.after = after
      if (filter !== undefined) vars.filter = filter

      const response = (await withRateLimitRetry(
        () =>
          (
            client as unknown as {
              client: {
                rawRequest: (q: string, v: unknown) => Promise<{ data?: unknown; error?: string }>
              }
            }
          ).client.rawRequest(query, vars),
        input.retryOptsOverride,
      )) as { data?: unknown; error?: string }

      if (response.error ?? !response.data) {
        throw LinearAgentError.linear.apiError({
          message: response.error ?? 'no data returned from Linear API',
          details: { command: 'cycle list', cause: response.error },
        })
      }

      const conn = (response.data as { cycles?: { nodes?: unknown[]; pageInfo?: unknown } }).cycles
      const nodes = (conn?.nodes ?? []) as Record<string, unknown>[]
      const pageInfoRaw = conn?.pageInfo as
        | {
            hasNextPage?: boolean
            endCursor?: string | null
            hasPreviousPage?: boolean
            startCursor?: string | null
          }
        | undefined

      const projected = nodes.map((node) => project(node, fields))

      const complexity = getLastComplexity()
      const meta: Omit<Meta, 'command'> = {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        pageInfo: {
          hasNextPage: Boolean(pageInfoRaw?.hasNextPage),
          endCursor: pageInfoRaw?.endCursor ?? null,
          hasPreviousPage: Boolean(pageInfoRaw?.hasPreviousPage),
          startCursor: pageInfoRaw?.startCursor ?? null,
        },
        ...(complexity !== undefined ? { complexity } : {}),
      }

      return { data: projected, meta }
    })
  }

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'

    let filter: CycleFilter | undefined
    if (input.flags.team !== undefined) {
      const teamId = await resolveTeamId(
        client,
        workspaceKey,
        input.flags.team,
        input.retryOptsOverride,
      )
      filter = { team: { id: { eq: teamId } } }
    }

    const cyclesArgs: { first: number; after?: string; filter?: CycleFilter } = { first }
    if (after !== undefined) cyclesArgs.after = after
    if (filter !== undefined) cyclesArgs.filter = filter

    const connection = (await withRateLimitRetry(
      () => client.cycles(cyclesArgs as unknown as Parameters<LinearClient['cycles']>[0]),
      input.retryOptsOverride,
    )) as unknown as SdkCycleConnection

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

// -----------------------------------------------------------------------------
// Lazy-property hydration -- cycles expose `team` as a lazy promise getter.
// Hydrate ONLY when the projection spec references a relation. Mirrors
// project-list-runtime / issue-list-runtime patterns.
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['team'])

async function hydrateForProjection(
  cycle: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(cycle)) {
      if (!RELATION_KEYS.has(k)) out[k] = cycle[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(cycle)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = cycle[k]
        hydrated[k] = await resolveLazy(value)
      }
      // else: skip -- don't read the lazy getter at all.
    } else {
      hydrated[k] = cycle[k]
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

// -----------------------------------------------------------------------------
// Phase 3: compose query for --include path (Approach A — single rawRequest)
// -----------------------------------------------------------------------------

function composeCycleListWithIncludes(fragmentText: string): string {
  return `
    query CyclesWithIncludes($filter: CycleFilter, $first: Int!, $after: String) {
      cycles(filter: $filter, first: $first, after: $after) {
        nodes {
          id number name description startsAt endsAt completedAt progress
          isActive isPast isFuture isNext isPrevious
          createdAt updatedAt archivedAt
          team { id name key }
          ${fragmentText}
        }
        pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
      }
    }
  `.trim()
}
