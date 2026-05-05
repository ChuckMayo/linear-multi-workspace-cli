/**
 * `project get <ref>` runtime -- Phase 2 PLAN 02-07 Task 1, PRJ-01.get.
 *
 * Single-entity read. Accepts EITHER a project name OR a UUID. Names route
 * through `resolveProjectId` from Plan 02-02 (workspace-scoped, bulk-fetched
 * once per invocation). UUIDs short-circuit and call `client.project(uuid)`
 * directly because Linear's API only accepts UUIDs at that endpoint.
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input, 'project')
 *   3. UUID? -> client.project(ref) directly.
 *      Otherwise -> resolveProjectId(client, workspace, ref) -> uuid, then
 *      client.project(uuid).
 *   4. project + meta. NO pageInfo (single entity).
 *
 * Errors:
 *   - PROJECT_NOT_FOUND (exit 13) -- resolver miss OR client.project returns
 *     undefined for a UUID input.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { redact } from '@/core/redact/index.js'
import { resolveProjectId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'
import { validateAndMergeIncludes } from '@/lib/include-fragments.js'

export interface ProjectGetArgs {
  /** Project name or UUID. Required. */
  ref: string
}

export interface ProjectGetFlags {
  workspace?: string
  fields?: string
  /** Phase 3: hydrate related entities in a single rawRequest round-trip */
  include?: string[]
}

export interface ProjectGetInput {
  args: ProjectGetArgs
  flags: ProjectGetFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface ProjectGetOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

export async function projectGetRuntime(input: ProjectGetInput): Promise<ProjectGetOutput> {
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
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  // Phase 3: branch on --include. Empty → unchanged Phase 2 typed-SDK call.
  const includes = input.flags.include ?? []
  if (includes.length > 0) {
    const fragmentText = validateAndMergeIncludes('project get', includes)
    const query = composeProjectGetWithIncludes(fragmentText)

    return withFetchInterception(async () => {
      const ref = input.args.ref
      const workspaceKey = resolved.name ?? '_api-key-env_'

      // Resolve to UUID (name path goes through resolver, UUID short-circuits).
      const projectId = UUID_RE.test(ref)
        ? ref
        : await resolveProjectId(client, workspaceKey, ref, input.retryOptsOverride)

      const response = (await withRateLimitRetry(
        () =>
          (
            client as unknown as {
              client: {
                rawRequest: (q: string, v: unknown) => Promise<{ data?: unknown; error?: string }>
              }
            }
          ).client.rawRequest(query, { id: projectId }),
        input.retryOptsOverride,
      )) as { data?: unknown; error?: string }

      if (response.error ?? !response.data) {
        // WR-05: scrub token-shaped substrings before constructing the
        // LinearAgentError — its constructor throws on `lin_api_*` /
        // `lin_oauth_*` substrings (defense in depth).
        const safeMessage = redact(response.error ?? 'no data returned from Linear API')
        const safeCause = response.error !== undefined ? redact(response.error) : undefined
        throw LinearAgentError.linear.apiError({
          message: safeMessage,
          details: { command: 'project get', cause: safeCause },
        })
      }

      const projectData = (response.data as { project?: Record<string, unknown> }).project
      if (!projectData) {
        throw new LinearAgentError({
          code: 'PROJECT_NOT_FOUND',
          message: `project not found: ${ref}`,
          details: { ref },
        })
      }

      const data = project(projectData, fields)

      const complexity = getLastComplexity()
      const meta: Omit<Meta, 'command'> = {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        ...(complexity !== undefined ? { complexity } : {}),
      }

      return { data, meta }
    })
  }

  return withFetchInterception(async () => {
    const ref = input.args.ref
    const workspaceKey = resolved.name ?? '_api-key-env_'

    // Resolve to UUID -- UUID short-circuits, name goes through resolver.
    const projectId = UUID_RE.test(ref)
      ? ref
      : await resolveProjectId(client, workspaceKey, ref, input.retryOptsOverride)

    const proj = (await withRateLimitRetry(
      () => client.project(projectId),
      input.retryOptsOverride,
    )) as unknown as Record<string, unknown> | null | undefined

    if (!proj) {
      throw new LinearAgentError({
        code: 'PROJECT_NOT_FOUND',
        message: `project not found: ${ref}`,
        details: { ref },
      })
    }

    const hydrated = await hydrateForProjection(proj, fields)
    const data = project(hydrated, fields)

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data, meta }
  })
}

// -----------------------------------------------------------------------------
// Lazy-property hydration -- mirrors project-list-runtime (lead, creator).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['lead', 'creator'])

async function hydrateForProjection(
  proj: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
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

// -----------------------------------------------------------------------------
// Phase 3: compose query for --include path (Approach A — single rawRequest)
// -----------------------------------------------------------------------------

function composeProjectGetWithIncludes(fragmentText: string): string {
  // BL-03 fix: widen the scalar set to match the project ALLOWED_FIELDS
  // registry (src/core/projection/project.ts). Without this, the
  // --include branch silently returned a strict subset of --fields=full
  // (progress, sortOrder, startedAt, completedAt, color, icon, etc.
  // were missing).
  return `
    query ProjectWithIncludes($id: String!) {
      project(id: $id) {
        id name description state progress sortOrder
        startDate targetDate startedAt completedAt canceledAt archivedAt
        createdAt updatedAt
        color icon slugId url
        lead { id email name }
        creator { id email name }
        ${fragmentText}
      }
    }
  `.trim()
}
