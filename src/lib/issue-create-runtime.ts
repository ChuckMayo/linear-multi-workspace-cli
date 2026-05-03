/**
 * `issue create` runtime — Phase 2 PLAN 02-04 Task 1, ISS-03.
 *
 * Write command. Mints a new Linear issue with up to 9 optional fields
 * (description, state, assignee, labels, project, cycle, priority, parent,
 * plus the required title + team). Five resolvers from Plan 02-02 are
 * consumed: `resolveTeamId`, `resolveStateNameToId`, `resolveLabelIds`,
 * `resolveProjectId`, `resolveCycleId`. Parent issues and assignees
 * (`me` / email / UUID) are resolved inline.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. `requireExplicitWorkspaceForWrite()` (WSP-06).
 *   2. Required-flag validation (`--title`, `--team`) → USAGE_ERROR exit 2.
 *
 * After both gates pass, the team is resolved first (sequential — needed
 * by the team-scoped resolvers), then the remaining 5 lookups run in
 * parallel via `Promise.all`. The createIssue input is assembled with
 * conditional spread so omitted flags do NOT surface as `undefined` keys.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) — write-guard, before SDK.
 *   - USAGE_ERROR (exit 2) — missing required flag.
 *   - WORKFLOW_STATE_NOT_FOUND / LABEL_NOT_FOUND / PROJECT_NOT_FOUND /
 *     CYCLE_NOT_FOUND / TEAM_NOT_FOUND / ISSUE_NOT_FOUND (exit 13) — resolver
 *     surfaces.
 *   - LINEAR_API_ERROR (exit 13) — assignee email lookup miss; payload
 *     `success === false`.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID — via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  resolveCycleId,
  resolveLabelIds,
  resolveProjectId,
  resolveStateNameToId,
  resolveTeamId,
} from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { EMAIL_RE, ISSUE_IDENTIFIER_RE, UUID_RE } from '@/lib/filter-heuristics.js'

/** Reserved for future positional args; currently no args (title is a flag). */
export type IssueCreateArgs = Record<string, never>

export interface IssueCreateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  // Required (validated as required by the runtime, not by oclif's flag schema).
  title?: string
  team?: string
  // Optional.
  description?: string
  state?: string
  assignee?: string
  labels?: string
  project?: string
  cycle?: string
  priority?: number
  parent?: string
}

export interface IssueCreateInput {
  args: IssueCreateArgs
  flags: IssueCreateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueCreateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface CreateIssuePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface SdkUserConnection {
  nodes: Array<{ id: string; email?: string; name?: string }>
}

interface SdkIssueConnection {
  nodes: Array<{ id: string }>
}

export async function issueCreateRuntime(input: IssueCreateInput): Promise<IssueCreateOutput> {
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

  // WSP-06 gate — runs BEFORE required-flag validation, factory, or any SDK
  // call. The factoryOverride is therefore never invoked when the workspace
  // is implicit (`active` / `single`).
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  // Required-flag validation — BEFORE any SDK call. CONTEXT line 47:
  // `issue create` minimum is title + team.
  if (input.flags.title === undefined || input.flags.title === '') {
    throw LinearAgentError.usage('--title is required')
  }
  if (input.flags.team === undefined || input.flags.team === '') {
    throw LinearAgentError.usage('--team is required')
  }
  const title: string = input.flags.title
  const teamRef: string = input.flags.team

  const fields = parseFields(input.flags.fields ?? 'defaults', 'issue')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    // Cache key for team-scoped resolvers. When resolved.name is null
    // (api-key-env path with no registered workspace), use a literal sentinel
    // matching the convention from Plan 02-03.
    const workspaceKey = resolved.name ?? '_api-key-env_'

    // 1. Resolve teamId first — required by state, label, and cycle resolvers.
    const teamId = await resolveTeamId(client, workspaceKey, teamRef, input.retryOptsOverride)

    // 2. Resolve all other names in parallel.
    const flags = input.flags
    const [stateId, labelIds, projectId, cycleId, parentId, assigneeId] = await Promise.all([
      flags.state !== undefined
        ? resolveStateNameToId(client, workspaceKey, teamId, flags.state, input.retryOptsOverride)
        : Promise.resolve(undefined),
      flags.labels !== undefined && flags.labels !== ''
        ? resolveLabelIds(
            client,
            workspaceKey,
            teamId,
            flags.labels
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            input.retryOptsOverride,
          )
        : Promise.resolve(undefined),
      flags.project !== undefined
        ? resolveProjectId(client, workspaceKey, flags.project, input.retryOptsOverride)
        : Promise.resolve(undefined),
      flags.cycle !== undefined
        ? resolveCycleId(client, workspaceKey, teamId, flags.cycle, input.retryOptsOverride)
        : Promise.resolve(undefined),
      flags.parent !== undefined
        ? resolveIssueRefToUuid(client, flags.parent, input.retryOptsOverride)
        : Promise.resolve(undefined),
      flags.assignee !== undefined
        ? resolveAssignee(client, flags.assignee, input.retryOptsOverride)
        : Promise.resolve(undefined),
    ])

    // 3. Build the IssueCreateInput with conditional spread (avoid setting
    //    keys to `undefined` — keeps the minimum-input snapshot tight).
    const createInput: Record<string, unknown> = { teamId, title }
    if (flags.description !== undefined) createInput.description = flags.description
    if (stateId !== undefined) createInput.stateId = stateId
    if (assigneeId !== undefined) createInput.assigneeId = assigneeId
    if (labelIds !== undefined) createInput.labelIds = labelIds
    if (projectId !== undefined) createInput.projectId = projectId
    if (cycleId !== undefined) createInput.cycleId = cycleId
    if (flags.priority !== undefined) createInput.priority = flags.priority
    if (parentId !== undefined) createInput.parentId = parentId

    // 4. Mutate.
    const payload = (await withRateLimitRetry(
      () =>
        client.createIssue(createInput as unknown as Parameters<LinearClient['createIssue']>[0]),
      input.retryOptsOverride,
    )) as unknown as CreateIssuePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'createIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // 5. Project the created issue when SDK returns one. Mirrors
    //    `issue-transition-runtime.ts`: empty `{}` if SDK omits the issue
    //    (avoids an extra round-trip).
    let created: Record<string, unknown> | undefined
    if (payload.issue !== undefined) {
      const i = await Promise.resolve(payload.issue)
      if (i !== undefined && i !== null) created = i as Record<string, unknown>
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

/**
 * Resolve a parent issue reference (`ENG-42` or UUID) to an issue UUID.
 * Mirrors the `resolveIssue` helper in `issue-get-runtime.ts` but limited to
 * the parent-id use case (no full issue hydration needed).
 */
async function resolveIssueRefToUuid(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref
  const m = ISSUE_IDENTIFIER_RE.exec(ref)
  if (!m) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `parent issue not found: ${ref}`,
      details: { ref },
    })
  }
  const teamKey = (m[1] as string).toUpperCase()
  const number = Number(m[2])
  const filter = {
    team: { key: { eq: teamKey } },
    number: { eq: number },
  }
  const conn = (await withRateLimitRetry(
    () =>
      client.issues({
        filter,
        first: 1,
      } as unknown as Parameters<LinearClient['issues']>[0]),
    retryOpts,
  )) as unknown as SdkIssueConnection
  const node = conn.nodes[0]
  if (!node) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `parent issue not found: ${ref}`,
      details: { ref },
    })
  }
  return node.id
}

/**
 * Resolve a free-form assignee reference to a user UUID:
 *   - `me`           → `client.viewer.id`
 *   - UUID           → passthrough
 *   - email-shaped   → `client.users({ filter: { email: { eq } }, first: 1 })`
 *   - other          → `client.users({ filter: { name: { eq } }, first: 1 })`
 */
export async function resolveAssignee(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (ref === 'me') {
    const viewer = (await withRateLimitRetry(
      () => Promise.resolve((client as unknown as { viewer: unknown }).viewer),
      retryOpts,
    )) as unknown as { id: string }
    return viewer.id
  }
  if (UUID_RE.test(ref)) return ref
  const filter = EMAIL_RE.test(ref) ? { email: { eq: ref } } : { name: { eq: ref } }
  const conn = (await withRateLimitRetry(
    () =>
      client.users({
        filter,
        first: 1,
      } as unknown as Parameters<LinearClient['users']>[0]),
    retryOpts,
  )) as unknown as SdkUserConnection
  const node = conn.nodes[0]
  if (!node) {
    throw LinearAgentError.linear.apiError({
      message: `assignee not found: ${ref}`,
      details: { ref },
    })
  }
  return node.id
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (mirrors `issue-get-runtime.ts` /
// `issue-transition-runtime.ts`).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['state', 'assignee', 'team', 'project', 'cycle', 'parent'])

async function hydrateForProjection(
  issue: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(issue)) {
      if (!RELATION_KEYS.has(k)) out[k] = issue[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(issue)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = issue[k]
        hydrated[k] = await resolveLazy(value)
      }
    } else {
      hydrated[k] = issue[k]
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
