/**
 * `project list` runtime -- Phase 2 PLAN 02-07 Task 1, PRJ-01.list.
 *
 * Read command. Lists projects workspace-wide. Wraps `client.projects({ first,
 * after })` in `withRateLimitRetry` inside `withFetchInterception`. Uses
 * `parseFields(input, 'project')` for projection, with the 02-01 default
 * preset (8 fields including `lead.email`, `description`, `targetDate`).
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'project')
 *   3. parsePagination -> { first, after }
 *   4. withFetchInterception(async () => withRateLimitRetry(client.projects(...)))
 *   5. Hydrate lazy relations (lead, creator) ONLY when projection references
 *      them -- narrows N+1 surface (mirrors comment-list-runtime).
 *   6. project + meta with pageInfo, opt-in complexity.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement. Reads are allowed against
 * the active default workspace.
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

export interface ProjectListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
}

export interface ProjectListInput {
  flags: ProjectListFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface ProjectListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SdkProjectConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

export async function projectListRuntime(input: ProjectListInput): Promise<ProjectListOutput> {
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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'project')
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const projectsArgs: { first: number; after?: string } = { first }
    if (after !== undefined) projectsArgs.after = after

    const connection = (await withRateLimitRetry(
      () => client.projects(projectsArgs as unknown as Parameters<LinearClient['projects']>[0]),
      input.retryOptsOverride,
    )) as unknown as SdkProjectConnection

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
// Lazy-property hydration -- projects expose lead, creator as lazy promise
// getters. Hydrate ONLY when the projection spec needs them. (Teams is a
// connection on Project; we don't surface it via the standard projection.)
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['lead', 'creator'])

async function hydrateForProjection(
  proj: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    // No relations needed -- copy non-relation keys only so we don't
    // accidentally trigger a relation getter via spread enumeration on
    // `--fields=ids`.
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(proj)) {
      if (!RELATION_KEYS.has(k)) out[k] = proj[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(proj)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = proj[k]
        hydrated[k] = await resolveLazy(value)
      }
      // else: skip -- don't read the lazy getter at all.
    } else {
      hydrated[k] = proj[k]
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
