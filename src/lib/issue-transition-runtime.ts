/**
 * `issue transition` runtime — Phase 2 PLAN 02-03 Task 2, ISS-05.
 *
 * Write command. Resolves the issue ref (identifier or UUID), reads its
 * teamId, resolves the state name to an ID via `resolveStateNameToId`
 * (Plan 02-02), then mutates via `client.updateIssue(id, { stateId })`.
 *
 * WSP-06 enforcement: `requireExplicitWorkspaceForWrite()` runs BEFORE any
 * SDK call (T-02-15 mitigation). Without `--workspace`, `LINEAR_WORKSPACE`,
 * `LINEAR_API_KEY`, or the per-invocation `--allow-active-workspace-write`
 * opt-in, the runtime throws `WORKSPACE_REQUIRED_FOR_WRITE` and the factory
 * is never invoked.
 *
 * Identifier vs UUID routing mirrors `issue-get-runtime.ts` — same regex
 * (ISSUE_IDENTIFIER_RE), same team.key + number filter for the
 * identifier branch.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) — write-guard, before SDK
 *   - ISSUE_NOT_FOUND (exit 13) — identifier or UUID resolved nothing
 *   - WORKFLOW_STATE_NOT_FOUND (exit 13) — state name not found in team
 *   - LINEAR_API_ERROR (exit 13) — payload.success === false
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID — via transport classifier
 */

import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveStateNameToId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { ISSUE_IDENTIFIER_RE } from '@/lib/filter-heuristics.js'

export interface IssueTransitionArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  identifier: string
  /** State name (e.g. "In Progress") or state UUID. Required. */
  state: string
}

export interface IssueTransitionFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
}

export interface IssueTransitionInput {
  args: IssueTransitionArgs
  flags: IssueTransitionFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueTransitionOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

/** Filter shape for the identifier-resolution branch. */
interface IssueIdentifierFilter {
  team: { key: { eq: string } }
  number: { eq: number }
}

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
}

interface UpdateIssuePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export async function issueTransitionRuntime(
  input: IssueTransitionInput,
): Promise<IssueTransitionOutput> {
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

  // WSP-06: enforce BEFORE any SDK call (and BEFORE constructing the client).
  // T-02-15 mitigation - write commands must not silently inherit the active
  // default workspace.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  const fields = parseFields(input.flags.fields ?? 'defaults', 'issue')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    // 1. Resolve issue ref to { issueId, teamId }
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
    // The Issue.team relation is a lazy promise getter on @linear/sdk; await it.
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

    // 2. Resolve state name to state ID (UUID passthrough handled by resolver).
    const workspaceKey = resolved.name ?? '_api-key-env_'
    const stateId = await resolveStateNameToId(
      client,
      workspaceKey,
      teamId,
      input.args.state,
      input.retryOptsOverride,
    )

    // 3. Mutate.
    const payload = (await withRateLimitRetry(
      () => client.updateIssue(issueId, { stateId }),
      input.retryOptsOverride,
    )) as unknown as UpdateIssuePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    // 4. Project the updated issue (when SDK returns one). Fall back to a
    //    minimal data shape if the payload omits the issue (avoids an extra
    //    round-trip).
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
    const filter: IssueIdentifierFilter = {
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
  // UUID path.
  const issue = (await withRateLimitRetry(() => client.issue(ref), retryOpts)) as unknown as
    | Record<string, unknown>
    | null
    | undefined
  return issue ?? undefined
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (mirrors issue-get-runtime.ts).
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
