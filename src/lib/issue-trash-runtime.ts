/**
 * `issue trash` runtime — Phase 2 PLAN 02-05 Task 1, ISS-06.trash.
 *
 * Soft 30-day delete. Calls `client.deleteIssue(uuid)` (default
 * permanentlyDelete=false — Linear retains the issue for ~30 days). WSP-06
 * enforced BEFORE the SDK call. NO `--yes` flag — trash is reversible
 * within 30 days via Linear's UI (CONTEXT line 49).
 *
 * Step ordering (load-bearing):
 *   1. resolveWorkspace
 *   2. requireExplicitWorkspaceForWrite (WSP-06 — refuses 'active' / 'single')
 *   3. createLinearClient
 *   4. resolve issue ref to UUID (identifier path → client.issues filter;
 *      UUID path → fast-path, no SDK round-trip)
 *   5. client.deleteIssue(uuid)  — NO second arg, default soft delete
 *   6. payload.success check → LINEAR_API_ERROR if false
 *   7. project + meta envelope (data.trashed: true)
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) — write-guard, before SDK.
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

export interface IssueTrashArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  identifier: string
}

export interface IssueTrashFlags {
  workspace?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
}

export interface IssueTrashInput {
  args: IssueTrashArgs
  flags: IssueTrashFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueTrashOutput {
  data: { id: string; identifier?: string; trashed: true }
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

export async function issueTrashRuntime(input: IssueTrashInput): Promise<IssueTrashOutput> {
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

  // WSP-06 -- runs BEFORE any SDK call (and before constructing the client).
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const ref = input.args.identifier
    const { id, identifier } = await resolveIssueRef(client, ref, input.retryOptsOverride)

    // Soft delete -- pass NO second arg so Linear's default
    // permanentlyDelete:false applies. We deliberately do NOT pass
    // `{ permanentlyDelete: false }` because the SDK type for the second
    // arg is optional, and an explicit `false` would be churn against the
    // typed-SDK signature without changing behavior.
    const payload = (await withRateLimitRetry(
      () => client.deleteIssue(id),
      input.retryOptsOverride,
    )) as unknown as DeletePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'deleteIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    const data: { id: string; identifier?: string; trashed: true } = { id, trashed: true }
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
  // includeArchived:true -- trash MUST resolve archived issues. `issue archive`
  // flips the archived flag, and Linear's `issues` connection filters those
  // out by default. Without this, an archive→trash chain on the same
  // identifier maps to ISSUE_NOT_FOUND. Trashing an archived issue is a
  // valid Linear operation (trash is a strict superset of archive).
  const conn = (await withRateLimitRetry(
    () =>
      client.issues({
        filter: { team: { key: { eq: teamKey } }, number: { eq: number } },
        first: 1,
        includeArchived: true,
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
