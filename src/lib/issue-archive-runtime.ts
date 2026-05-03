/**
 * `issue archive` runtime — Phase 2 PLAN 02-05 Task 1, ISS-06.archive.
 *
 * Reversible archive. Calls `client.archiveIssue(uuid)`. WSP-06 enforced
 * BEFORE the SDK call. NO `--yes` flag — archive is reversible in the
 * Linear UI (CONTEXT line 49).
 *
 * Step ordering (load-bearing):
 *   1. resolveWorkspace
 *   2. requireExplicitWorkspaceForWrite (WSP-06 — refuses 'active' / 'single')
 *   3. createLinearClient
 *   4. resolve issue ref to UUID (identifier path → client.issues filter;
 *      UUID path → fast-path, no SDK round-trip)
 *   5. client.archiveIssue(uuid)
 *   6. payload.success check → LINEAR_API_ERROR if false
 *   7. project + meta envelope
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

export interface IssueArchiveArgs {
  /** Issue identifier (ENG-123) or UUID. Required. */
  identifier: string
}

export interface IssueArchiveFlags {
  workspace?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
}

export interface IssueArchiveInput {
  args: IssueArchiveArgs
  flags: IssueArchiveFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueArchiveOutput {
  data: { id: string; identifier?: string; archived: true }
  meta: Omit<Meta, 'command'>
}

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
}

interface ArchivePayload {
  success: boolean
  lastSyncId: number
  entity?: Record<string, unknown>
}

export async function issueArchiveRuntime(input: IssueArchiveInput): Promise<IssueArchiveOutput> {
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

    const payload = (await withRateLimitRetry(
      () => client.archiveIssue(id),
      input.retryOptsOverride,
    )) as unknown as ArchivePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'archiveIssue returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    const data: { id: string; identifier?: string; archived: true } = { id, archived: true }
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

/**
 * Resolve a user-typed issue ref (ENG-123 or UUID) to a UUID + identifier.
 * UUID path is a no-op (no SDK round-trip); identifier path uses the
 * team-key + number filter. Inlined per the plan note: each runtime in this
 * plan keeps its own resolution helper for cross-plan independence.
 */
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
