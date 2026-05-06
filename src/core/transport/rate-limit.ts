/**
 * Rate-limit-aware transport wrapper (Phase 2 PLAN 02-01, RAT-01 / RAT-03).
 *
 * Every Phase 2 SDK call routes through `withRateLimitRetry`. The wrapper
 *   1. retries on `RatelimitedLinearError` and `NetworkLinearError` with
 *      exponential backoff + full jitter (RAT-01 default policy);
 *   2. classifies all other thrown SDK errors into `LinearAgentError`
 *      instances via `classifySdkError` (RAT-03) so the kernel envelope
 *      shape stays canonical.
 *
 * The classifier discriminates on `@linear/sdk` typed error classes
 * (`RatelimitedLinearError`, `AuthenticationLinearError`, `NetworkLinearError`,
 * `InvalidInputLinearError`, `LinearError`) — NOT regex on `err.message` and
 * NOT `errors[].extensions.code`. Phase 1's two regex-based message-substring
 * classifiers (formerly in issue-list-runtime + workspace-runtime) are
 * retired in Plan 02-01 Task 3; this module is the canonical replacement.
 *
 * Default backoff policy (RAT-01):
 *   - Rate-limit: base 250ms doubling (250 → 500 → 1000) with full jitter,
 *     OR `err.retryAfter * 1000` capped at `4 × base`. 3 attempts.
 *   - Network:    base 100ms doubling (100 → 200 → 400) with full jitter.
 *                 3 attempts.
 *   - Auth/Validation/Other: NO retry — surfaced immediately.
 *
 * Test seams: callers may inject `opts.sleep` and `opts.random` to make
 * timing deterministic in unit tests. The `retryOptsOverride?: RetryOpts`
 * field on per-runtime input interfaces (issue-list-runtime, etc.) is the
 * test-only entry point — production call sites pass nothing.
 */

import {
  AuthenticationLinearError,
  InvalidInputLinearError,
  LinearError,
  NetworkLinearError,
  RatelimitedLinearError,
} from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'

export interface RetryOpts {
  /** Total attempt count, including the first try. Default 3. */
  maxAttempts?: number
  /**
   * Phase 6 MNT-03: additive bump on top of `maxAttempts`. Default 0. Min 0.
   * Lifts BOTH the rate-limit AND network branches uniformly (RESEARCH §6
   * Option B). `--retry 2` plus the default 3 → 5 total attempts on either
   * transient class. Non-transient errors (auth/validation) skip the loop.
   */
  extraAttempts?: number
  /** Rate-limit base backoff (ms). Default 250 → 500 → 1000 with full jitter. */
  rateLimitBaseMs?: number
  /** Network base backoff (ms). Default 100 → 200 → 400 with full jitter. */
  networkBaseMs?: number
  /** Sleep seam — defaults to a real `setTimeout` Promise. */
  sleep?: (ms: number) => Promise<void>
  /** Random seam — defaults to `Math.random`. */
  random?: () => number
  /**
   * Phase 6 MNT-03: per-attempt observability hook. Called BEFORE each sleep,
   * exactly once per FAILED attempt (the post-success path doesn't fire it).
   * `attempt` is 1-indexed and represents the attempt that just failed;
   * `total` is the resolved `maxAttempts` (after `extraAttempts` is applied).
   * Caller is responsible for gating on `--quiet` — the transport layer is
   * unaware of presentation concerns.
   */
  onRetry?: (info: {
    attempt: number
    total: number
    code: 'RATELIMITED' | 'NETWORK_ERROR'
    backoffMs: number
  }) => void
}

interface ResolvedRetryOpts {
  maxAttempts: number
  rateLimitBaseMs: number
  networkBaseMs: number
  sleep: (ms: number) => Promise<void>
  random: () => number
  onRetry?: RetryOpts['onRetry']
}

const DEFAULTS: ResolvedRetryOpts = {
  maxAttempts: 3,
  rateLimitBaseMs: 250,
  networkBaseMs: 100,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
}

const RATELIMIT_DEFAULT_RETRY_MS = 30_000

function resolveOpts(opts?: RetryOpts): ResolvedRetryOpts {
  const base = opts?.maxAttempts ?? DEFAULTS.maxAttempts
  const extra = Math.max(0, opts?.extraAttempts ?? 0)
  const resolved: ResolvedRetryOpts = {
    maxAttempts: base + extra,
    rateLimitBaseMs: opts?.rateLimitBaseMs ?? DEFAULTS.rateLimitBaseMs,
    networkBaseMs: opts?.networkBaseMs ?? DEFAULTS.networkBaseMs,
    sleep: opts?.sleep ?? DEFAULTS.sleep,
    random: opts?.random ?? DEFAULTS.random,
  }
  if (opts?.onRetry !== undefined) resolved.onRetry = opts.onRetry
  return resolved
}

/**
 * Wrap a thunk that performs an SDK call so it transparently retries on
 * rate-limit and network errors and classifies any thrown error into a
 * `LinearAgentError` before re-throwing.
 *
 * Successful inner calls return their value unchanged.
 *
 * Errors thrown by the inner call are funneled through `classifySdkError`
 * after the retry loop exhausts (or immediately for non-retryable cases).
 * If the inner call throws a `LinearAgentError` directly, it passes through
 * unchanged (idempotent — no double-wrapping).
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const o = resolveOpts(opts)
  // Guard: maxAttempts < 1 would skip the loop entirely and surface a
  // synthetic LINEAR_API_ERROR (`classifySdkError(undefined)`). Fail loud
  // on the misconfiguration instead -- callers always intend at least one
  // attempt.
  if (o.maxAttempts < 1) {
    throw LinearAgentError.usage(
      `withRateLimitRetry: maxAttempts must be >= 1 (got ${o.maxAttempts})`,
    )
  }
  let attempt = 0
  let lastErr: unknown
  while (attempt < o.maxAttempts) {
    try {
      return await call()
    } catch (err) {
      lastErr = err
      if (err instanceof RatelimitedLinearError) {
        if (attempt === o.maxAttempts - 1) break
        const base = o.rateLimitBaseMs * 2 ** attempt
        const hint = err.retryAfter !== undefined ? err.retryAfter * 1000 : undefined
        // Floor `hint` at `base` so a malformed `retry-after: 0` header
        // (or a misbehaving proxy / fixture) cannot collapse the delay to
        // 0ms and cause a tight retry loop.
        const sleepMs =
          hint !== undefined ? Math.max(Math.min(hint, base * 4), base) : base + o.random() * base
        // Phase 6 MNT-03: per-attempt observability hook. Called BEFORE the
        // sleep so the caller's stderr line shows up while the wait is
        // happening (greppable progress signal).
        o.onRetry?.({
          attempt: attempt + 1,
          total: o.maxAttempts,
          code: 'RATELIMITED',
          backoffMs: Math.round(sleepMs),
        })
        await o.sleep(sleepMs)
        attempt++
        continue
      }
      if (err instanceof NetworkLinearError) {
        if (attempt === o.maxAttempts - 1) break
        const base = o.networkBaseMs * 2 ** attempt
        const sleepMs = base + o.random() * base
        o.onRetry?.({
          attempt: attempt + 1,
          total: o.maxAttempts,
          code: 'NETWORK_ERROR',
          backoffMs: Math.round(sleepMs),
        })
        await o.sleep(sleepMs)
        attempt++
        continue
      }
      // Non-retryable — break and classify below.
      break
    }
  }
  // Phase 6 MNT-03: tag final-exhaustion attempt count onto error.details
  // ONLY when the caller opts into retry observability (passes
  // `extraAttempts > 0` or `onRetry`). Default callers get the Phase 2
  // byte-identical failure shape — `attempts` is not tagged unless asked
  // for, so the existing transport snapshot tests stay green and the
  // Phase 1 envelope contract is unchanged for the 99% case.
  //
  // EXCEPTION: a `LinearAgentError` thrown directly by the inner call
  // passes through `classifySdkError` unchanged — preserve idempotent
  // reference equality (Test 10) and never re-wrap.
  const classified = classifySdkError(lastErr)
  if (lastErr instanceof LinearAgentError && classified === lastErr) {
    throw classified
  }
  const wantsAttemptsTag =
    (opts?.extraAttempts !== undefined && opts.extraAttempts > 0) || opts?.onRetry !== undefined
  if (!wantsAttemptsTag) {
    throw classified
  }
  throw withAttempts(classified, attempt + 1)
}

/**
 * Return a `LinearAgentError` byte-identical to `err` except for an added
 * `details.attempts: count` key. Used to tag final-exhaustion attempt
 * counts without mutating `LinearAgentError`'s readonly `details`.
 */
function withAttempts(err: LinearAgentError, count: number): LinearAgentError {
  const mergedDetails: Record<string, unknown> = { ...(err.details ?? {}), attempts: count }
  const init: {
    code: typeof err.code
    message: string
    transient: boolean
    retryAfterMs?: number
    details: Record<string, unknown>
  } = {
    code: err.code,
    message: err.message,
    transient: err.transient,
    details: mergedDetails,
  }
  if (err.retryAfterMs !== undefined) init.retryAfterMs = err.retryAfterMs
  return new LinearAgentError(init)
}

/**
 * Classify any thrown SDK error into the canonical `LinearAgentError`
 * taxonomy. Idempotent: a `LinearAgentError` argument passes through
 * unchanged.
 *
 * Discrimination uses `instanceof` on `@linear/sdk` typed error classes —
 * NOT message regex, NOT `errors[].extensions.code`. The SDK already does
 * that work for us in `parseLinearError`.
 */
export function classifySdkError(err: unknown): LinearAgentError {
  if (err instanceof LinearAgentError) return err
  if (err instanceof RatelimitedLinearError) {
    const retryAfterMs =
      err.retryAfter !== undefined ? err.retryAfter * 1000 : RATELIMIT_DEFAULT_RETRY_MS
    const details: Record<string, unknown> = {}
    if (err.complexityRemaining !== undefined) details.complexityRemaining = err.complexityRemaining
    if (err.complexityLimit !== undefined) details.complexityLimit = err.complexityLimit
    if (err.complexityResetAt !== undefined) details.complexityResetAt = err.complexityResetAt
    return LinearAgentError.rateLimited(
      retryAfterMs,
      Object.keys(details).length > 0 ? details : undefined,
    )
  }
  if (err instanceof NetworkLinearError) {
    return LinearAgentError.network('network error during Linear API call')
  }
  if (err instanceof AuthenticationLinearError) {
    return LinearAgentError.auth.invalid('token rejected by Linear')
  }
  if (err instanceof InvalidInputLinearError) {
    const msg = err instanceof Error ? err.message : String(err)
    return LinearAgentError.validation.failed('Linear rejected the request payload', {
      cause: msg,
    })
  }
  if (err instanceof LinearError) {
    const msg = err instanceof Error ? err.message : String(err)
    return LinearAgentError.linear.apiError({
      message: 'Linear API call failed',
      details: { cause: msg },
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return LinearAgentError.linear.apiError({
    message: 'Linear API call failed',
    details: { cause: msg },
  })
}
