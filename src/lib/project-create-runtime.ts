/**
 * `project create` runtime -- Phase 2 PLAN 02-07 Task 2, PRJ-01.create.
 *
 * Write command. Mints a Linear project. Required: --name + --teams (Linear's
 * API requires at least one teamId in `teamIds: string[]`). Optional:
 * --description, --state, --lead (email/uuid/me), --start-date, --target-date.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *   2. Required-flag validation (--name, --teams) -> USAGE_ERROR exit 2.
 *      Empty/whitespace --teams (after split-and-trim yields zero entries)
 *      ALSO USAGE_ERROR.
 *
 * After both gates pass, --teams is split on `,`, trimmed, deduped via
 * `resolveTeamId` for each ref (in parallel via Promise.all). The createInput
 * is assembled with conditional spread so omitted flags do NOT surface as
 * `undefined` keys.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard, before SDK.
 *   - USAGE_ERROR (exit 2) -- missing required flag, or empty --teams.
 *   - TEAM_NOT_FOUND (exit 13) -- resolver miss.
 *   - LINEAR_API_ERROR (exit 13) -- assignee email lookup miss for --lead;
 *     payload `success === false`.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveTeamId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { resolveAssignee } from '@/lib/issue-create-runtime.js'

/** Reserved for future positional args; currently no args. */
export type ProjectCreateArgs = Record<string, never>

export interface ProjectCreateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  /** Required: project name. */
  name?: string
  /** Required: comma-separated team keys / UUIDs / names (>= 1). */
  teams?: string
  /** Optional: project description (markdown). */
  description?: string
  /** Optional: project state enum (e.g., 'planned', 'started'). */
  state?: string
  /** Optional: project lead -- 'me', email, name, or user UUID. */
  lead?: string
  /** Optional: project start date (ISO 8601). */
  startDate?: string
  /** Optional: project target date (ISO 8601). */
  targetDate?: string
}

export interface ProjectCreateInput {
  args: ProjectCreateArgs
  flags: ProjectCreateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface ProjectCreateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface CreateProjectPayload {
  success: boolean
  lastSyncId: number
  project?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export async function projectCreateRuntime(
  input: ProjectCreateInput,
): Promise<ProjectCreateOutput> {
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

  // WSP-06 gate -- BEFORE required-flag validation, factory, or any SDK call.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  // Required-flag validation -- BEFORE any SDK call.
  if (input.flags.name === undefined || input.flags.name === '') {
    throw LinearAgentError.usage('--name is required')
  }
  if (input.flags.teams === undefined || input.flags.teams === '') {
    throw LinearAgentError.usage('--teams is required (comma-separated team keys/UUIDs/names)')
  }
  const teamRefs = input.flags.teams
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (teamRefs.length === 0) {
    throw LinearAgentError.usage(
      '--teams is required (comma-separated team keys/UUIDs/names; got no valid entries)',
    )
  }

  const name: string = input.flags.name
  const fields = parseFields(input.flags.fields ?? 'defaults', 'project')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'
    const flags = input.flags

    // Resolve all teams in parallel + lead (if present) in the same Promise.all
    // batch. Resolvers are cached per-workspace, so sequential teams in the
    // same workspace share the bulk client.teams() fetch.
    const [teamIds, leadId] = await Promise.all([
      Promise.all(
        teamRefs.map((t) => resolveTeamId(client, workspaceKey, t, input.retryOptsOverride)),
      ),
      flags.lead !== undefined
        ? resolveAssignee(client, flags.lead, input.retryOptsOverride)
        : Promise.resolve(undefined),
    ])

    // Build the ProjectCreateInput with conditional spread.
    const createInput: Record<string, unknown> = { name, teamIds }
    if (flags.description !== undefined) createInput.description = flags.description
    if (flags.state !== undefined) createInput.state = flags.state
    if (leadId !== undefined) createInput.leadId = leadId
    if (flags.startDate !== undefined) createInput.startDate = flags.startDate
    if (flags.targetDate !== undefined) createInput.targetDate = flags.targetDate

    const payload = (await withRateLimitRetry(
      () =>
        client.createProject(
          createInput as unknown as Parameters<LinearClient['createProject']>[0],
        ),
      input.retryOptsOverride,
    )) as unknown as CreateProjectPayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'createProject returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    let created: Record<string, unknown> | undefined
    if (payload.project !== undefined) {
      const p = await Promise.resolve(payload.project)
      if (p !== undefined && p !== null) created = p as Record<string, unknown>
    }
    let data: unknown
    if (created) {
      const hydrated = await hydrateForProjection(created, fields)
      data = project(hydrated, fields)
    } else {
      data = {}
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
