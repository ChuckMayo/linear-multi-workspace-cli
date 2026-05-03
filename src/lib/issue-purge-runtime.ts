/**
 * `issue purge` runtime — Phase 2 PLAN 02-05 Task 1, ISS-06.purge.
 *
 * Permanent delete (calls `client.deleteIssue(uuid, { permanentlyDelete:
 * true })`). Gated on `--yes`: without it, throws CONFIRMATION_REQUIRED
 * (exit 2) BEFORE any SDK call. T-02-22 mitigation — irreversible data loss
 * is a clear-confirmation surface.
 *
 * **Step ordering is load-bearing (Test 11):**
 *   1. resolveWorkspace
 *   2. requireExplicitWorkspaceForWrite (WSP-06 — refuses 'active' / 'single')
 *   3. CONFIRMATION_REQUIRED check (`--yes` gate)        ← AFTER WSP-06
 *   4. createLinearClient
 *   5. resolve issue ref to UUID
 *   6. client.deleteIssue(uuid, { permanentlyDelete: true })
 *   7. payload.success check → LINEAR_API_ERROR if false
 *   8. project + meta envelope (data.permanentlyDeleted: true)
 *
 * Why WSP-06 first: Test 11 pins the order. A caller passing only `--yes`
 * (without `--workspace`) MUST see WORKSPACE_REQUIRED_FOR_WRITE, not
 * CONFIRMATION_REQUIRED — the workspace gate is the more dangerous mistake
 * (cross-workspace data loss > "you forgot --yes").
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) — write-guard, before SDK.
 *   - CONFIRMATION_REQUIRED (exit 2) — `--yes` not set.
 *   - ISSUE_NOT_FOUND (exit 13) — identifier resolved to nothing.
 *   - LINEAR_API_ERROR (exit 13) — payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID — via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { ISSUE_IDENTIFIER_RE, UUID_RE } from '@/lib/filter-heuristics.js'

export interface IssuePurgeArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  identifier: string
}

export interface IssuePurgeFlags {
  workspace?: string
  /** Confirm permanent deletion. REQUIRED — without it, runtime throws
   *  CONFIRMATION_REQUIRED before any SDK call. */
  yes?: boolean
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
}

export interface IssuePurgeInput {
  args: IssuePurgeArgs
  flags: IssuePurgeFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssuePurgeOutput {
  data: { id: string; identifier?: string; permanentlyDeleted: true }
  meta: Omit<Meta, 'command'>
}

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
}

interface DeletePayload {
  success: boolean
  lastSyncId: number
  entity?: Record<string, unknown>
}

export async function issuePurgeRuntime(input: IssuePurgeInput): Promise<IssuePurgeOutput> {
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

  // 1. WSP-06 -- runs FIRST (Test 11).
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  // 2. CONFIRMATION_REQUIRED -- after WSP-06, BEFORE any SDK call (T-02-22).
  if (!input.flags.yes) {
    throw new LinearAgentError({
      code: 'CONFIRMATION_REQUIRED',
      message: 'purge is permanent -- re-run with --yes to confirm',
      details: { remediation: 'pass --yes to confirm permanent deletion' },
    })
  }

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const ref = input.args.identifier
    const { id, identifier } = await resolveIssueRef(client, ref, input.retryOptsOverride)

    // Permanent delete -- second arg has EXACTLY { permanentlyDelete: true }
    // (Test 10 pins the call shape).
    const payload = (await withRateLimitRetry(
      () => client.deleteIssue(id, { permanentlyDelete: true }),
      input.retryOptsOverride,
    )) as unknown as DeletePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'deleteIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    const data: { id: string; identifier?: string; permanentlyDeleted: true } = {
      id,
      permanentlyDeleted: true,
    }
    if (identifier !== undefined) data.identifier = identifier

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data, meta }
  })
}

async function resolveIssueRef(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<{ id: string; identifier?: string }> {
  if (UUID_RE.test(ref)) return { id: ref }
  const m = ref.match(ISSUE_IDENTIFIER_RE)
  if (!m) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `invalid issue ref: ${ref}`,
      details: { ref },
    })
  }
  const teamKey = (m[1] as string).toUpperCase()
  const number = Number(m[2])
  const conn = (await withRateLimitRetry(
    () =>
      client.issues({
        filter: { team: { key: { eq: teamKey } }, number: { eq: number } },
        first: 1,
      } as unknown as Parameters<LinearClient['issues']>[0]),
    retryOpts,
  )) as unknown as SdkIssueConnection
  const issue = conn.nodes[0]
  if (!issue) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `issue not found: ${ref}`,
      details: { ref },
    })
  }
  const idRaw = (issue as { id?: unknown }).id
  if (typeof idRaw !== 'string') {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `issue not found: ${ref}`,
      details: { ref },
    })
  }
  const idRes: { id: string; identifier?: string } = { id: idRaw }
  const idn = (issue as { identifier?: unknown }).identifier
  if (typeof idn === 'string') idRes.identifier = idn
  return idRes
}
