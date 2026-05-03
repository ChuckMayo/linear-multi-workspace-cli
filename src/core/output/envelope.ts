import type { ErrorCode, LinearAgentError } from '@/core/errors/index.js'

/**
 * Locked output envelope shapes per CONTEXT.md § Output Envelope (Phase 1,
 * frozen day 1). Snapshot tests in `test/core/output.test.ts` pin every
 * shape — drift breaks CI.
 *
 * Key-ordering invariant: success envelopes serialize as
 *   { $apiVersion, ok, data, meta }
 * and failure envelopes as
 *   { $apiVersion, ok, error, meta }
 * Object literals in `success()` / `failure()` below build keys in this
 * exact order so `JSON.stringify` output is byte-stable across runs.
 *
 * Optional-field invariant: `undefined` optional fields are stripped
 * before returning so the serialized JSON omits them entirely (rather than
 * emitting `null` or `undefined`). Agents reading the schema can rely on
 * "field absent" === "field unset"; "field present with null" only happens
 * for fields whose null is meaningful (`workspace: null` when running
 * via `LINEAR_API_KEY` env).
 */

export type WorkspaceSource = 'flag' | 'env' | 'active' | 'single' | 'api-key-env'

export type PageInfo = {
  hasNextPage: boolean
  endCursor: string | null
  hasPreviousPage: boolean
  startCursor: string | null
}

export type Meta = {
  command: string
  workspace?: string | null
  workspaceSource?: WorkspaceSource
  pageInfo?: PageInfo
  /**
   * Linear's complexity-meter readout for the LAST response observed
   * inside `withFetchInterception(...)` (Phase 2 PLAN 02-01, RAT-02).
   *
   * Strictly opt-in: runtimes must spread this only when
   * `getLastComplexity()` returned a value:
   *   `...(getLastComplexity() && { complexity: getLastComplexity() })`
   * This keeps Phase 1 snapshots byte-identical when tests mock at the
   * SDK class boundary (the mock bypasses globalThis.fetch, so no
   * complexity is captured).
   */
  complexity?: { cost: number; remaining: number }
  /**
   * Total result count for searches that surface it (Phase 2 plan 02-05
   * `issue search` → `IssueSearchPayload.totalCount`). Optional and
   * additive; Phase 1 envelopes never set it.
   */
  totalCount?: number
}

export type FailureMeta = Pick<Meta, 'command' | 'workspace' | 'workspaceSource'>

export type SuccessEnvelope<T = unknown> = {
  $apiVersion: '1'
  ok: true
  data: T
  meta: Meta
}

export type FailureEnvelopeError = {
  code: ErrorCode
  message: string
  transient: boolean
  retryAfterMs?: number
  details?: Record<string, unknown>
}

export type FailureEnvelope = {
  $apiVersion: '1'
  ok: false
  error: FailureEnvelopeError
  meta: FailureMeta
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | FailureEnvelope

/**
 * Build a stable Meta record with the canonical key order:
 *   command, workspace, workspaceSource, pageInfo, complexity, totalCount
 * Optional fields with `undefined` values are omitted; `null` workspaces
 * are preserved (they are meaningful — "ran via LINEAR_API_KEY env").
 *
 * `complexity` and `totalCount` are Phase 2 additions (PLAN 02-01). They
 * are placed AFTER pageInfo so any envelope that omits them serializes
 * identically to its Phase 1 byte-for-byte form.
 */
function buildMeta(meta: Meta): Meta {
  const out: Meta = { command: meta.command }
  if (meta.workspace !== undefined) out.workspace = meta.workspace
  if (meta.workspaceSource !== undefined) out.workspaceSource = meta.workspaceSource
  if (meta.pageInfo !== undefined) out.pageInfo = meta.pageInfo
  if (meta.complexity !== undefined) out.complexity = meta.complexity
  if (meta.totalCount !== undefined) out.totalCount = meta.totalCount
  return out
}

function buildFailureMeta(meta: FailureMeta): FailureMeta {
  const out: FailureMeta = { command: meta.command }
  if (meta.workspace !== undefined) out.workspace = meta.workspace
  if (meta.workspaceSource !== undefined) out.workspaceSource = meta.workspaceSource
  return out
}

export function success<T>(data: T, meta: Meta): SuccessEnvelope<T> {
  return {
    $apiVersion: '1',
    ok: true,
    data,
    meta: buildMeta(meta),
  }
}

export function failure(error: LinearAgentError, meta: FailureMeta): FailureEnvelope {
  const errOut: FailureEnvelopeError = {
    code: error.code,
    message: error.message,
    transient: error.transient,
  }
  if (error.retryAfterMs !== undefined) errOut.retryAfterMs = error.retryAfterMs
  if (error.details !== undefined) errOut.details = error.details
  return {
    $apiVersion: '1',
    ok: false,
    error: errOut,
    meta: buildFailureMeta(meta),
  }
}
