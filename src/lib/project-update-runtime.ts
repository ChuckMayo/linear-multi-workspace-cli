/**
 * `project update` runtime -- Phase 2 PLAN 02-07 Task 2, PRJ-01.update.
 *
 * Write command. Resolves a project ref (name or UUID) to a UUID, then calls
 * `client.updateProject(uuid, input)` with any subset of partial field flags.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *   2. VALIDATION_NO_FIELDS guard -- empty updates fail loud rather than
 *      silently no-op (parallel to issue update).
 *
 * After both gates pass, the project ref is resolved (UUID short-circuits;
 * name routes through `resolveProjectId`). The optional --lead flag is
 * resolved via `resolveAssignee` (shared with issue create / update).
 *
 * NOTE on update-status: `--status` is intentionally NOT a flag here. To
 * change a project's CURRENT status, use the dedicated `project update-status`
 * sub-command, which routes through `client.updateProject({ statusId })` after
 * resolving the status name -- exactly the same SDK call shape, but the
 * dedicated command keeps that load-bearing operation discoverable + the
 * input shape un-ambiguous (per RESEARCH § Pitfall 5).
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard.
 *   - VALIDATION_NO_FIELDS (exit 2) -- no field flags passed.
 *   - PROJECT_NOT_FOUND (exit 13) -- resolver miss.
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false; assignee email
 *     lookup miss for --lead.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveProjectId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'
import { resolveAssignee } from '@/lib/issue-create-runtime.js'

export interface ProjectUpdateArgs {
  /** Project name or UUID. Required. */
  ref: string
}

export interface ProjectUpdateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  // Field flags (any of which marks the update as non-empty).
  name?: string
  description?: string
  state?: string
  lead?: string
  startDate?: string
  targetDate?: string
}

export interface ProjectUpdateInput {
  args: ProjectUpdateArgs
  flags: ProjectUpdateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface ProjectUpdateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface UpdateProjectPayload {
  success: boolean
  lastSyncId: number
  project?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

const NO_FIELDS_MESSAGE =
  'no fields to update -- pass at least one of --name, --description, --state, --lead, --start-date, --target-date'

function hasAnyFieldFlag(flags: ProjectUpdateFlags): boolean {
  return (
    flags.name !== undefined ||
    flags.description !== undefined ||
    flags.state !== undefined ||
    flags.lead !== undefined ||
    flags.startDate !== undefined ||
    flags.targetDate !== undefined
  )
}

export async function projectUpdateRuntime(
  input: ProjectUpdateInput,
): Promise<ProjectUpdateOutput> {
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

  // VALIDATION_NO_FIELDS pre-check -- BEFORE issue resolution / SDK call.
  if (!hasAnyFieldFlag(input.flags)) {
    throw new LinearAgentError({
      code: 'VALIDATION_NO_FIELDS',
      message: NO_FIELDS_MESSAGE,
    })
  }

  const fields = parseFields(input.flags.fields ?? 'defaults', 'project')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'
    const ref = input.args.ref
    const flags = input.flags

    // 1. Resolve project ref to UUID (UUID short-circuits).
    const projectId = UUID_RE.test(ref)
      ? ref
      : await resolveProjectId(client, workspaceKey, ref, input.retryOptsOverride)

    // 2. Build the updateInput incrementally.
    const updateInput: Record<string, unknown> = {}
    if (flags.name !== undefined) updateInput.name = flags.name
    if (flags.description !== undefined) updateInput.description = flags.description
    if (flags.state !== undefined) updateInput.state = flags.state
    if (flags.startDate !== undefined) updateInput.startDate = flags.startDate
    if (flags.targetDate !== undefined) updateInput.targetDate = flags.targetDate
    if (flags.lead !== undefined) {
      updateInput.leadId = await resolveAssignee(client, flags.lead, input.retryOptsOverride)
    }

    // 3. Defense-in-depth: even though hasAnyFieldFlag was true, ensure the
    //    final input has at least one key.
    if (Object.keys(updateInput).length === 0) {
      throw new LinearAgentError({
        code: 'VALIDATION_NO_FIELDS',
        message: NO_FIELDS_MESSAGE,
      })
    }

    // 4. Mutate.
    const payload = (await withRateLimitRetry(
      () =>
        client.updateProject(
          projectId,
          updateInput as unknown as Parameters<LinearClient['updateProject']>[1],
        ),
      input.retryOptsOverride,
    )) as unknown as UpdateProjectPayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateProject returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // 5. Project the updated project when SDK returns one.
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
      data = { id: projectId }
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
// Lazy-property hydration -- mirrors project-list / project-get runtimes.
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
