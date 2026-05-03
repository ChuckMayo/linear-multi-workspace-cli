/**
 * `issue update` runtime — Phase 2 PLAN 02-04 Task 2, ISS-04.
 *
 * Write command. Resolves the issue (identifier or UUID), reads its team for
 * team-scoped resolvers, builds an `IssueUpdateInput` from any of 11 partial
 * field flags, then calls `client.updateIssue(id, input)`.
 *
 * **Three label modes co-exist** (CONTEXT line 44; RESEARCH lines 808-817):
 *   - `--labels p0,bug`        -> `input.labelIds`           (replace)
 *   - `--add-label p0` (xN)    -> `input.addedLabelIds`      (additive)
 *   - `--remove-label legacy`  -> `input.removedLabelIds`    (subtractive)
 * Linear's API decides precedence when multiple modes are passed; this
 * runtime maps each flag to its distinct key without merging.
 *
 * **VALIDATION_NO_FIELDS guard** (CONTEXT line 43; T-02-19 mitigation):
 * a no-field-flags update is thrown as VALIDATION_NO_FIELDS (exit 2) BEFORE
 * any SDK call (the guard runs after WSP-06 but before issue resolution).
 * Empty updates are almost always a mistake -- fail loud rather than
 * silently no-op.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard, before SDK.
 *   - VALIDATION_NO_FIELDS (exit 2) -- no field flags passed.
 *   - ISSUE_NOT_FOUND (exit 13) -- identifier or UUID resolved nothing.
 *   - WORKFLOW_STATE_NOT_FOUND / LABEL_NOT_FOUND / PROJECT_NOT_FOUND /
 *     CYCLE_NOT_FOUND (exit 13) -- resolver surfaces.
 *   - LINEAR_API_ERROR (exit 13) -- assignee email lookup miss; payload
 *     `success === false`.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  resolveCycleId,
  resolveLabelId,
  resolveLabelIds,
  resolveProjectId,
  resolveStateNameToId,
} from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { ISSUE_IDENTIFIER_RE } from '@/lib/filter-heuristics.js'
import { resolveAssignee } from '@/lib/issue-create-runtime.js'

export interface IssueUpdateArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  identifier: string
}

export interface IssueUpdateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  // Field flags (any of which marks the update as non-empty).
  title?: string
  description?: string
  state?: string
  assignee?: string
  /** Replace mode (comma-separated). Maps to IssueUpdateInput.labelIds. */
  labels?: string
  /** Add mode (repeatable). Maps to IssueUpdateInput.addedLabelIds. */
  addLabel?: string[]
  /** Remove mode (repeatable). Maps to IssueUpdateInput.removedLabelIds. */
  removeLabel?: string[]
  project?: string
  cycle?: string
  priority?: number
}

export interface IssueUpdateInput {
  args: IssueUpdateArgs
  flags: IssueUpdateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueUpdateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
}

interface UpdateIssuePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

/**
 * Returns true if any field flag is set (i.e. the update is non-empty).
 * Empty-string `description` counts as set (intentional clear-the-description
 * value per Test 8).
 */
function hasAnyFieldFlag(flags: IssueUpdateFlags): boolean {
  return (
    flags.title !== undefined ||
    flags.description !== undefined ||
    flags.state !== undefined ||
    flags.assignee !== undefined ||
    (flags.labels !== undefined && flags.labels !== '') ||
    (flags.addLabel !== undefined && flags.addLabel.length > 0) ||
    (flags.removeLabel !== undefined && flags.removeLabel.length > 0) ||
    flags.project !== undefined ||
    flags.cycle !== undefined ||
    flags.priority !== undefined
  )
}

const NO_FIELDS_MESSAGE =
  'no fields to update -- pass at least one of --title, --description, --state, --assignee, --labels, --add-label, --remove-label, --priority, --project, --cycle'

export async function issueUpdateRuntime(input: IssueUpdateInput): Promise<IssueUpdateOutput> {
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

  // WSP-06 gate -- runs BEFORE any SDK call.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  // VALIDATION_NO_FIELDS pre-check -- a no-field-flags update would be a
  // silent no-op against Linear; fail loud instead. This runs BEFORE issue
  // resolution so the SDK is never touched. T-02-19 mitigation.
  if (!hasAnyFieldFlag(input.flags)) {
    throw new LinearAgentError({
      code: 'VALIDATION_NO_FIELDS',
      message: NO_FIELDS_MESSAGE,
    })
  }

  const fields = parseFields(input.flags.fields ?? 'defaults', 'issue')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    // 1. Resolve issue ref to { issueId, teamId }.
    const ref = input.args.identifier
    const issue = await resolveIssue(client, ref, input.retryOptsOverride)
    if (!issue) {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue not found: ${ref}`,
        details: { ref },
      })
    }
    const issueIdRaw = (issue as { id?: unknown }).id
    if (typeof issueIdRaw !== 'string') {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue not found: ${ref}`,
        details: { ref },
      })
    }
    const issueId: string = issueIdRaw
    const teamRaw = await Promise.resolve((issue as { team?: unknown }).team)
    const teamId =
      teamRaw && typeof teamRaw === 'object' && typeof (teamRaw as { id?: unknown }).id === 'string'
        ? (teamRaw as { id: string }).id
        : undefined
    if (!teamId) {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue has no team: ${ref}`,
        details: { ref },
      })
    }

    const workspaceKey = resolved.name ?? '_api-key-env_'
    const flags = input.flags

    // 2. Build the IssueUpdateInput incrementally.
    const updateInput: Record<string, unknown> = {}
    if (flags.title !== undefined) updateInput.title = flags.title
    if (flags.description !== undefined) updateInput.description = flags.description
    if (flags.priority !== undefined) updateInput.priority = flags.priority
    if (flags.state !== undefined) {
      updateInput.stateId = await resolveStateNameToId(
        client,
        workspaceKey,
        teamId,
        flags.state,
        input.retryOptsOverride,
      )
    }
    if (flags.assignee !== undefined) {
      updateInput.assigneeId = await resolveAssignee(
        client,
        flags.assignee,
        input.retryOptsOverride,
      )
    }
    if (flags.project !== undefined) {
      updateInput.projectId = await resolveProjectId(
        client,
        workspaceKey,
        flags.project,
        input.retryOptsOverride,
      )
    }
    if (flags.cycle !== undefined) {
      updateInput.cycleId = await resolveCycleId(
        client,
        workspaceKey,
        teamId,
        flags.cycle,
        input.retryOptsOverride,
      )
    }
    // Three label modes -- each maps to a DISTINCT key. Linear's API arbitrates
    // precedence at write time (T-02-21 documented as accept-with-test).
    if (flags.labels !== undefined && flags.labels !== '') {
      const names = flags.labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      updateInput.labelIds = await resolveLabelIds(
        client,
        workspaceKey,
        teamId,
        names,
        input.retryOptsOverride,
      )
    }
    if (flags.addLabel !== undefined && flags.addLabel.length > 0) {
      updateInput.addedLabelIds = await Promise.all(
        flags.addLabel.map((l) =>
          resolveLabelId(client, workspaceKey, teamId, l, input.retryOptsOverride),
        ),
      )
    }
    if (flags.removeLabel !== undefined && flags.removeLabel.length > 0) {
      updateInput.removedLabelIds = await Promise.all(
        flags.removeLabel.map((l) =>
          resolveLabelId(client, workspaceKey, teamId, l, input.retryOptsOverride),
        ),
      )
    }

    // 3. Defense-in-depth: even though hasAnyFieldFlag was true, ensure the
    //    final input object has at least one key.
    if (Object.keys(updateInput).length === 0) {
      throw new LinearAgentError({
        code: 'VALIDATION_NO_FIELDS',
        message: NO_FIELDS_MESSAGE,
      })
    }

    // 4. Mutate.
    const payload = (await withRateLimitRetry(
      () =>
        client.updateIssue(
          issueId,
          updateInput as unknown as Parameters<LinearClient['updateIssue']>[1],
        ),
      input.retryOptsOverride,
    )) as unknown as UpdateIssuePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // 5. Project the updated issue when SDK returns one.
    let updated: Record<string, unknown> | undefined
    if (payload.issue !== undefined) {
      const u = await Promise.resolve(payload.issue)
      if (u !== undefined && u !== null) updated = u as Record<string, unknown>
    }
    let data: unknown
    if (updated) {
      const hydrated = await hydrateForProjection(updated, fields)
      data = project(hydrated, fields)
    } else {
      data = { id: issueId }
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

async function resolveIssue(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<Record<string, unknown> | undefined> {
  const m = ISSUE_IDENTIFIER_RE.exec(ref)
  if (m) {
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
    return conn.nodes[0]
  }
  // UUID path -- client.issue(id) accepts UUID only.
  const issue = (await withRateLimitRetry(() => client.issue(ref), retryOpts)) as unknown as
    | Record<string, unknown>
    | null
    | undefined
  return issue ?? undefined
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (mirrors issue-get / transition / create runtimes).
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
