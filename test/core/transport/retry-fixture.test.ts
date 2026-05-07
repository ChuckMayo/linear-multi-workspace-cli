/**
 * Fault-injection tests for `--retry N` (Phase 6 PLAN 06-02, MNT-03).
 *
 * Coverage of CONTEXT D-MNT-03 + RESEARCH §6 Option B:
 *   (a) `extraAttempts: 2` on rate-limit succeeds after 5 total attempts.
 *   (b) `extraAttempts: 2` on network error succeeds after 5 total attempts.
 *   (c) `extraAttempts: 99` on `AuthenticationLinearError` throws after exactly 1 attempt.
 *   (d) On final exhaustion, the thrown `LinearAgentError.details.attempts === total attempts made`.
 *   (e) `onRetry` is invoked once per failed attempt; absent `onRetry` produces no spy calls.
 *   (f) `onRetry` info objects produce the greppable stderr line shape.
 *
 * The transport layer (`withRateLimitRetry`) is unaware of `--quiet`; the
 * caller (`runCommand` in `src/lib/workspace-runtime.ts`) is the gate that
 * decides whether to pass an `onRetry` writer. These tests exercise the
 * transport contract directly. The runCommand-level gating is tested in
 * `test/lib/workspace-runtime.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    complexityRemaining?: number
    complexityLimit?: number
    complexityResetAt?: number | Date
    constructor(opts?: {
      message?: string
      retryAfter?: number
      complexityRemaining?: number
      complexityLimit?: number
      complexityResetAt?: number | Date
    }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
      if (opts?.complexityRemaining !== undefined)
        this.complexityRemaining = opts.complexityRemaining
      if (opts?.complexityLimit !== undefined) this.complexityLimit = opts.complexityLimit
      if (opts?.complexityResetAt !== undefined) this.complexityResetAt = opts.complexityResetAt
    }
  }
  class NetworkLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'network error')
      this.name = 'NetworkLinearError'
    }
  }
  class AuthenticationLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'auth error')
      this.name = 'AuthenticationLinearError'
    }
  }
  class InvalidInputLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'invalid input')
      this.name = 'InvalidInputLinearError'
    }
  }
  class InternalLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'internal')
      this.name = 'InternalLinearError'
    }
  }
  return {
    LinearError,
    RatelimitedLinearError,
    NetworkLinearError,
    AuthenticationLinearError,
    InvalidInputLinearError,
    InternalLinearError,
  }
})

import {
  AuthenticationLinearError as RealAuthenticationLinearError,
  NetworkLinearError as RealNetworkLinearError,
  RatelimitedLinearError as RealRatelimitedLinearError,
} from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'

// vi.mock above replaces @linear/sdk at module-load with our own classes
// whose constructors accept a test-friendly options bag. Cast away the
// real SDK constructor signatures.
type RatelimitedOpts = {
  message?: string
  retryAfter?: number
  complexityRemaining?: number
  complexityLimit?: number
  complexityResetAt?: number | Date
}
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (
  opts?: RatelimitedOpts,
) => Error
const NetworkLinearError = RealNetworkLinearError as unknown as new (msg?: string) => Error
const AuthenticationLinearError = RealAuthenticationLinearError as unknown as new (
  msg?: string,
) => Error

// Deterministic seams — match `rate-limit.test.ts` conventions: random=0.5
// so jittered sleep equals base*1.5; sleep is a vi.fn that resolves immediately.
function makeSeams(): Pick<RetryOpts, 'sleep' | 'random'> {
  return {
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0.5,
  }
}

describe('withRateLimitRetry — --retry N (extraAttempts) extends both transient branches', () => {
  it('(a) extraAttempts: 2 on RatelimitedLinearError succeeds after 5 attempts when call errors 4×', async () => {
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      if (attempts < 5) throw new RatelimitedLinearError()
      return { ok: true } as const
    })
    const result = await withRateLimitRetry(call, { ...makeSeams(), extraAttempts: 2 })
    expect(result).toEqual({ ok: true })
    expect(attempts).toBe(5)
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('(b) extraAttempts: 2 on NetworkLinearError succeeds after 5 attempts when call errors 4×', async () => {
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      if (attempts < 5) throw new NetworkLinearError()
      return { ok: true } as const
    })
    const result = await withRateLimitRetry(call, { ...makeSeams(), extraAttempts: 2 })
    expect(result).toEqual({ ok: true })
    expect(attempts).toBe(5)
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('(c) extraAttempts: 99 on AuthenticationLinearError throws after exactly 1 attempt (non-transient short-circuit)', async () => {
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      throw new AuthenticationLinearError()
    })
    await expect(
      withRateLimitRetry(call, { ...makeSeams(), extraAttempts: 99 }),
    ).rejects.toBeInstanceOf(LinearAgentError)
    expect(attempts).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('withRateLimitRetry — final-exhaustion attempt count plumb', () => {
  it('(d) on final exhaustion, thrown LinearAgentError carries details.attempts === total attempts made', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError()
    })
    let caught: unknown
    try {
      await withRateLimitRetry(call, { ...seams, extraAttempts: 2 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LinearAgentError)
    const err = caught as LinearAgentError
    expect(err.code).toBe('RATELIMITED')
    // 3 (default) + 2 (extra) = 5 total attempts.
    expect(err.details?.attempts).toBe(5)
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('(d2) when opted in via onRetry (no extraAttempts), default exhaustion still tags details.attempts === 3', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new NetworkLinearError()
    })
    let caught: unknown
    try {
      // Passing `onRetry` opts the caller in to retry observability —
      // attempts are tagged even with the default `maxAttempts: 3`.
      await withRateLimitRetry(call, { ...seams, onRetry: () => {} })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LinearAgentError)
    const err = caught as LinearAgentError
    expect(err.code).toBe('NETWORK_ERROR')
    expect(err.details?.attempts).toBe(3)
  })

  it('(d3) default behavior (no extraAttempts, no onRetry) is byte-identical to Phase 2 — details.attempts NOT tagged', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError({ complexityRemaining: 99 })
    })
    let caught: unknown
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LinearAgentError)
    const err = caught as LinearAgentError
    // Phase 2 byte-identity: details mirrors the SDK error fields, no
    // attempts key when the caller didn't opt in.
    expect(err.details).toEqual({ complexityRemaining: 99 })
    expect((err.details as Record<string, unknown>).attempts).toBeUndefined()
  })
})

describe('withRateLimitRetry — onRetry observability hook', () => {
  it('(e) onRetry is invoked once per failed attempt; undefined onRetry produces zero invocations', async () => {
    const calls: Array<{ attempt: number; total: number; code: string; backoffMs: number }> = []
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      if (attempts < 5) throw new RatelimitedLinearError()
      return { ok: true } as const
    })
    await withRateLimitRetry(call, {
      ...makeSeams(),
      extraAttempts: 2,
      onRetry: (info) => {
        calls.push(info)
      },
    })
    // 4 failed attempts → 4 onRetry invocations; 5th attempt succeeds (no onRetry).
    expect(calls).toHaveLength(4)
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3, 4])
    for (const c of calls) {
      expect(c.total).toBe(5)
      expect(c.code).toBe('RATELIMITED')
    }

    // WR-06: meaningful coverage for the absence-of-effect on the happy path.
    // Pass `spy` as `onRetry` to a withRateLimitRetry that NEVER fails — the
    // hook contract says onRetry fires only on failed attempts, so a clean
    // run must produce zero invocations. (Pre-WR-06 this asserted on a spy
    // that was never wired to anything, which was trivially true regardless
    // of withRateLimitRetry's behavior.)
    const spy = vi.fn()
    const happyCall = vi.fn().mockResolvedValue({ ok: true } as const)
    const happyResult = await withRateLimitRetry(happyCall, { ...makeSeams(), onRetry: spy })
    expect(happyResult).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
    expect(happyCall).toHaveBeenCalledTimes(1)
  })

  it('(f) onRetry info objects format into greppable stderr line shape', async () => {
    const captured: Array<{ attempt: number; total: number; code: string; backoffMs: number }> = []
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      if (attempts < 3) throw new RatelimitedLinearError()
      return { ok: true } as const
    })
    await withRateLimitRetry(call, {
      ...makeSeams(),
      onRetry: (info) => {
        captured.push(info)
      },
    })
    expect(captured).toHaveLength(2)
    const regex = /^\[retry \d+\/\d+\] [A-Z_]+: backing off \d+ms$/
    for (const info of captured) {
      const line = `[retry ${info.attempt}/${info.total}] ${info.code}: backing off ${info.backoffMs}ms`
      expect(line).toMatch(regex)
      expect(['RATELIMITED', 'NETWORK_ERROR']).toContain(info.code)
      expect(info.attempt).toBeGreaterThanOrEqual(1)
      expect(info.total).toBeGreaterThanOrEqual(info.attempt)
      expect(Number.isInteger(info.backoffMs)).toBe(true)
    }
  })

  it('(f2) onRetry fires for the network branch with code === NETWORK_ERROR', async () => {
    const captured: Array<{ code: string }> = []
    let attempts = 0
    const call = vi.fn().mockImplementation(async () => {
      attempts += 1
      if (attempts < 2) throw new NetworkLinearError()
      return { ok: true } as const
    })
    await withRateLimitRetry(call, {
      ...makeSeams(),
      onRetry: (info) => {
        captured.push({ code: info.code })
      },
    })
    expect(captured).toEqual([{ code: 'NETWORK_ERROR' }])
  })
})
