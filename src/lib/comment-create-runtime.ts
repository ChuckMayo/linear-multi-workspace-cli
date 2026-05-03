/**
 * `comment create` runtime -- Phase 2 PLAN 02-06 Task 1, CMT-01.create.
 *
 * Write command. Calls `client.createComment({ body, issueId, parentId? })`.
 * Per RESEARCH 02-06 line 887, `CommentCreateInput.issueId` accepts BOTH a
 * UUID AND a Linear identifier (`ENG-123`) -- so we pass the user's value
 * straight through without resolving it client-side. This is the documented
 * SDK shortcut: faster path, fewer round-trips.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *   2. Required-flag validation (--issue, --body) -> USAGE_ERROR exit 2.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard, before SDK.
 *   - USAGE_ERROR (exit 2) -- missing --issue or --body.
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'

/** Reserved for future positional args; currently no args. */
export type CommentCreateArgs = Record<string, never>

export interface CommentCreateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  /** Required: issue UUID OR identifier (ENG-123). */
  issue?: string
  /** Required: comment body (markdown). */
  body?: string
  /** Optional: parent comment UUID for threaded replies. */
  parent?: string
}

export interface CommentCreateInput {
  args: CommentCreateArgs
  flags: CommentCreateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CommentCreateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface CreateCommentPayload {
  success: boolean
  lastSyncId: number
  comment?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export async function commentCreateRuntime(
  input: CommentCreateInput,
): Promise<CommentCreateOutput> {
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
  if (input.flags.body === undefined) {
    throw LinearAgentError.usage('--body is required')
  }
  if (input.flags.issue === undefined || input.flags.issue === '') {
    throw LinearAgentError.usage('--issue is required')
  }
  const body: string = input.flags.body
  const issue: string = input.flags.issue

  const fields = parseFields(input.flags.fields ?? 'defaults', 'comment')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    // Per RESEARCH 02-06 line 887, CommentCreateInput.issueId accepts a
    // Linear identifier (ENG-123) directly -- no client-side resolution
    // required. This is the documented SDK shortcut for the common case.
    const createInput: Record<string, unknown> = { body, issueId: issue }
    if (input.flags.parent !== undefined) createInput.parentId = input.flags.parent

    const payload = (await withRateLimitRetry(
      () =>
        client.createComment(
          createInput as unknown as Parameters<LinearClient['createComment']>[0],
        ),
      input.retryOptsOverride,
    )) as unknown as CreateCommentPayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'createComment returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    let created: Record<string, unknown> | undefined
    if (payload.comment !== undefined) {
      const c = await Promise.resolve(payload.comment)
      if (c !== undefined && c !== null) created = c as Record<string, unknown>
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
// Lazy-property hydration (mirrors comment-list-runtime).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['user', 'issue', 'parent'])

async function hydrateForProjection(
  comment: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    // No relations needed -- copy non-relation keys only so we don't
    // accidentally trigger a relation getter via spread enumeration on
    // `--fields=ids`. Mirrors issue-get-runtime.ts:167-193.
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(comment)) {
      if (!RELATION_KEYS.has(k)) out[k] = comment[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(comment)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = comment[k]
        hydrated[k] = await resolveLazy(value)
      }
      // else: skip -- don't read the lazy getter at all
    } else {
      hydrated[k] = comment[k]
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
