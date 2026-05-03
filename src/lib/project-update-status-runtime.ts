/**
 * `project update-status <ref> <status>` runtime --
 * Phase 2 PLAN 02-07 Task 2, PRJ-01.update-status.
 *
 * **CRITICAL** -- this runtime sets a project's CURRENT status by calling
 * `client.updateProject(projectId, { statusId })`. It MUST NOT call the
 * SDK's status-DEFINITION mutator (the workspace admin operation that
 * renames / recolors / repositions the status row that all projects share);
 * RESEARCH § Pitfall 5 names that trap explicitly. The agent-meaningful
 * "set this project to At Risk" operation lives on the project itself, NOT
 * on the status definition.
 *
 * See:
 *   - `.planning/phases/02-curated-command-coverage/02-RESEARCH.md` § Pitfall 5
 *     (lines 693-706) for the canonical write-up of the trap.
 *   - `src/core/resolvers/project-status.ts` -- the resolver header documents
 *     the same trap so callers see the warning at import time.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *
 * After the gate passes, both the project ref AND the status ref are resolved
 * in parallel (both resolvers passthrough on UUID). The mutation is a SINGLE
 * call: `client.updateProject(projectId, { statusId })`.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard.
 *   - PROJECT_NOT_FOUND (exit 13) -- project ref OR status ref miss; the
 *     resolver's message disambiguates ("project not found" vs. "project
 *     status not found").
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveProjectId, resolveProjectStatusId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'

export interface ProjectUpdateStatusArgs {
  /** Project name or UUID. Required. */
  ref: string
  /** Status name or UUID (e.g., "On Track", "At Risk"). Required. */
  status: string
}

export interface ProjectUpdateStatusFlags {
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
}

export interface ProjectUpdateStatusInput {
  args: ProjectUpdateStatusArgs
  flags: ProjectUpdateStatusFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface ProjectUpdateStatusOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface UpdateProjectPayload {
  success: boolean
  lastSyncId: number
  project?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export async function projectUpdateStatusRuntime(
  input: ProjectUpdateStatusInput,
): Promise<ProjectUpdateStatusOutput> {
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

  // WSP-06 gate -- BEFORE any SDK call.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  const fields = parseFields(input.flags.fields ?? 'defaults', 'project')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'

    // Resolve project ref + status ref in parallel. Both resolvers passthrough
    // on UUID (cheap), so this is one bulk client.projects() + one bulk
    // client.projectStatuses() at most.
    const [projectId, statusId] = await Promise.all([
      resolveProjectId(client, workspaceKey, input.args.ref, input.retryOptsOverride),
      resolveProjectStatusId(client, workspaceKey, input.args.status, input.retryOptsOverride),
    ])

    // **The load-bearing call**: updateProject({ statusId }) -- the
    // project-mutation path. The status-DEFINITION mutator (an admin op
    // that would rename / recolor / move the status row workspace-wide) is
    // explicitly NOT called here -- see RESEARCH § Pitfall 5.
    const payload = (await withRateLimitRetry(
      () => client.updateProject(projectId, { statusId }),
      input.retryOptsOverride,
    )) as unknown as UpdateProjectPayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateProject returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // Project the updated project when SDK returns one.
    let updated: Record<string, unknown> | undefined
    if (payload.project !== undefined) {
      const u = await Promise.resolve(payload.project)
      if (u !== undefined && u !== null) updated = u as Record<string, unknown>
    }
    let data: unknown
    if (updated) {
      const hydrated = await hydrateForProjection(updated, fields)
      data = project(hydrated, fields)
    } else {
      // Minimal echo so agents that didn't ask for projection still see the
      // ids they just bound together.
      data = { id: projectId, statusId }
    }

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
// Lazy-property hydration -- mirrors project-list / project-get / project-update.
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
