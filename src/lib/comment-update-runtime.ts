/**
 * `comment update` runtime -- Phase 2 PLAN 02-06 Task 2, CMT-01.update.
 *
 * Write command. Calls `client.updateComment(uuid, { body })`. WSP-06
 * enforced BEFORE any SDK call. VALIDATION_NO_FIELDS guard runs BEFORE any
 * SDK call when no field flags are passed (parallel to issue update's
 * pre-SDK guard).
 *
 * Step ordering (load-bearing):
 *   1. resolveWorkspace
 *   2. requireExplicitWorkspaceForWrite (WSP-06 -- refuses 'active' / 'single')
 *   3. VALIDATION_NO_FIELDS pre-check (no body flag passed -> exit 2)
 *   4. createLinearClient
 *   5. client.updateComment(uuid, input)
 *   6. payload.success check -> LINEAR_API_ERROR if false
 *   7. project + meta envelope
 *
 * Empty-string body (`--body ''`) is accepted -- the runtime forwards the
 * empty value to Linear (which decides whether to accept it). The
 * VALIDATION_NO_FIELDS check is `flags.body === undefined`, NOT
 * `flags.body === undefined || flags.body === ''`, mirroring the
 * issue-update behavior for `--description ''`.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard, before SDK.
 *   - VALIDATION_NO_FIELDS (exit 2) -- no field flags passed.
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

export interface CommentUpdateArgs {
  /** Comment UUID. Required. */
  id: string
}

export interface CommentUpdateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  /** New comment body (markdown). Pass "" to clear. */
  body?: string
}

export interface CommentUpdateInput {
  args: CommentUpdateArgs
  flags: CommentUpdateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CommentUpdateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface UpdateCommentPayload {
  success: boolean
  lastSyncId: number
  comment?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

const NO_FIELDS_MESSAGE = 'no fields to update -- pass --body'

export async function commentUpdateRuntime(
  input: CommentUpdateInput,
): Promise<CommentUpdateOutput> {
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

  // VALIDATION_NO_FIELDS pre-check -- runs BEFORE the client is built. A
  // no-field-flags update would silently no-op against Linear; fail loud.
  if (input.flags.body === undefined) {
    throw new LinearAgentError({
      code: 'VALIDATION_NO_FIELDS',
      message: NO_FIELDS_MESSAGE,
    })
  }

  const fields = parseFields(input.flags.fields ?? 'defaults', 'comment')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const updateInput: Record<string, unknown> = { body: input.flags.body }

    const payload = (await withRateLimitRetry(
      () =>
        client.updateComment(
          input.args.id,
          updateInput as unknown as Parameters<LinearClient['updateComment']>[1],
        ),
      input.retryOptsOverride,
    )) as unknown as UpdateCommentPayload
    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'updateComment returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    let updated: Record<string, unknown> | undefined
    if (payload.comment !== undefined) {
      const c = await Promise.resolve(payload.comment)
      if (c !== undefined && c !== null) updated = c as Record<string, unknown>
    }
    let data: unknown
    if (updated) {
      const hydrated = await hydrateForProjection(updated, fields)
      data = project(hydrated, fields)
    } else {
      data = { id: input.args.id }
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
// Lazy-property hydration -- mirrors comment-list/create runtimes.
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
