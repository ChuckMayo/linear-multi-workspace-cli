/**
 * `comment delete` runtime -- Phase 2 PLAN 02-06 Task 2, CMT-01.delete.
 *
 * Write command. Calls `client.deleteComment(uuid)`. WSP-06 enforced BEFORE
 * any SDK call. NO `--yes` gate -- comments are individually low-stakes;
 * --yes is reserved for irreversible operations (only `issue purge` per
 * CONTEXT line 49). Linear's UI also offers undo for comment deletion.
 *
 * Step ordering:
 *   1. resolveWorkspace
 *   2. requireExplicitWorkspaceForWrite (WSP-06)
 *   3. createLinearClient
 *   4. client.deleteComment(uuid)
 *   5. payload.success check -> LINEAR_API_ERROR if false
 *   6. Return { data: { id, deleted: true }, meta }
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard, before SDK.
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
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

export interface CommentDeleteArgs {
  /** Comment UUID. Required. */
  id: string
}

export interface CommentDeleteFlags {
  workspace?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
}

export interface CommentDeleteInput {
  args: CommentDeleteArgs
  flags: CommentDeleteFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CommentDeleteOutput {
  data: { id: string; deleted: true }
  meta: Omit<Meta, 'command'>
}

interface DeletePayload {
  success: boolean
  lastSyncId: number
  entity?: { id?: string }
}

export async function commentDeleteRuntime(
  input: CommentDeleteInput,
): Promise<CommentDeleteOutput> {
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

  // WSP-06 -- runs BEFORE any SDK call.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const payload = (await withRateLimitRetry(
      () => client.deleteComment(input.args.id),
      input.retryOptsOverride,
    )) as unknown as DeletePayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'deleteComment returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return {
      data: { id: input.args.id, deleted: true as const },
      meta,
    }
  })
}
