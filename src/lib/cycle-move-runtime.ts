/**
 * `cycle move <issue-ref> --to <cycle-ref>` runtime --
 * Phase 2 PLAN 02-08 Task 2, CYC-01.move.
 *
 * Write command. Moves a Linear issue to a different cycle. Linear has NO
 * dedicated "move cycle" mutation -- cycle is a property on Issue. This
 * runtime calls `client.updateIssue(issueId, { cycleId })`.
 *
 * The `<cycle-ref>` accepts 7 shapes via `resolveCycleId` from Plan 02-02:
 *   - UUID                          -- passthrough
 *   - `current` / `0`               -- active cycle
 *   - `next` / `+1`                 -- index after active in number-sorted list
 *   - `previous` / `-1`             -- index before active
 *   - `+N` / `-N`                   -- arbitrary offset from active index
 *   - cycle.name (case-insensitive) -- name lookup
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *
 * Pipeline (after WSP-06):
 *   1. Resolve issue ref to { issueId, teamId } (ENG-N via client.issues filter,
 *      UUID via client.issue). Cycle resolver NEEDS teamId, so even UUID input
 *      requires a fetch.
 *   2. resolveCycleId(client, ws, teamId, args.to) -> cycleId.
 *   3. client.updateIssue(issueId, { cycleId }) wrapped in transport.
 *   4. Project the updated issue per --fields=defaults (issue preset).
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard.
 *   - ISSUE_NOT_FOUND (exit 13) -- issue ref didn't resolve.
 *   - CYCLE_NOT_FOUND (exit 13) -- cycle ref didn't resolve (resolver surface).
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveCycleId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { ISSUE_IDENTIFIER_RE } from '@/lib/filter-heuristics.js'

export interface CycleMoveArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  issue: string
  /** Cycle ref: UUID, +N/-N/0, current/next/previous, or cycle name. Required. */
  to: string
}

export interface CycleMoveFlags {
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
}

export interface CycleMoveInput {
  args: CycleMoveArgs
  flags: CycleMoveFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CycleMoveOutput {
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

export async function cycleMoveRuntime(input: CycleMoveInput): Promise<CycleMoveOutput> {
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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'issue')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'

    // 1. Resolve issue ref to { issueId, teamId }.
    const ref = input.args.issue
    const issueObj = await resolveIssue(client, ref, input.retryOptsOverride)
    if (!issueObj) {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue not found: ${ref}`,
        details: { ref },
      })
    }
    const issueIdRaw = (issueObj as { id?: unknown }).id
    if (typeof issueIdRaw !== 'string') {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue not found: ${ref}`,
        details: { ref },
      })
    }
    const issueId: string = issueIdRaw
    const teamRaw = await Promise.resolve((issueObj as { team?: unknown }).team)
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

    // 2. Resolve cycle ref via the cycle resolver (handles all 7 ref shapes).
    const cycleId = await resolveCycleId(
      client,
      workspaceKey,
      teamId,
      input.args.to,
      input.retryOptsOverride,
    )

    // 3. Mutate. Linear has NO dedicated cycle-move mutation -- cycle is a
    //    property on Issue, set via updateIssue.
    const payload = (await withRateLimitRetry(
      () =>
        client.updateIssue(issueId, { cycleId } as unknown as Parameters<
          LinearClient['updateIssue']
        >[1]),
      input.retryOptsOverride,
    )) as unknown as UpdateIssuePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // 4. Project the updated issue when SDK returns one.
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
      data = { id: issueId, cycleId }
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
 * Resolve an issue reference (ENG-123 or UUID) to its full Issue object.
 * Mirrors `issue-update-runtime.ts`'s helper -- duplicated rather than
 * extracted because the rule-of-three threshold hasn't been hit yet (issue-get,
 * issue-transition, issue-update, and now cycle-move all carry their own
 * copies; a future refactor may consolidate them in `src/lib/issue-ref.ts`).
 */
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
  const fetched = (await withRateLimitRetry(() => client.issue(ref), retryOpts)) as unknown as
    | Record<string, unknown>
    | null
    | undefined
  return fetched ?? undefined
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (mirrors issue-update / issue-get runtimes).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['state', 'assignee', 'team', 'project', 'cycle', 'parent'])

async function hydrateForProjection(
  iss: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(iss)) {
      if (!RELATION_KEYS.has(k)) out[k] = iss[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(iss)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = iss[k]
        hydrated[k] = await resolveLazy(value)
      }
    } else {
      hydrated[k] = iss[k]
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
