/**
 * Unit tests for `withRateLimitRetry` and `classifySdkError`
 * (Phase 2 PLAN 02-01 Task 1, RAT-01 + RAT-03).
 *
 * `@linear/sdk` is mocked at the module level so we can throw arbitrary
 * instances of the typed error classes without depending on the SDK's
 * actual `parseLinearError` machinery. The transport module imports the
 * classes from `@linear/sdk` at module-load time, so the mock takes effect
 * before `rate-limit.ts` resolves its imports.
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
  InternalLinearError as RealInternalLinearError,
  InvalidInputLinearError as RealInvalidInputLinearError,
  NetworkLinearError as RealNetworkLinearError,
  RatelimitedLinearError as RealRatelimitedLinearError,
} from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { classifySdkError, withRateLimitRetry } from '@/core/transport/rate-limit.js'

// vi.mock above replaces @linear/sdk at module-load with our own classes
// whose constructors accept a test-friendly options bag. Cast away the
// real SDK constructor signature for the mock-construction call sites.
type RatelimitedLinearErrorOpts = {
  message?: string
  retryAfter?: number
  complexityRemaining?: number
  complexityLimit?: number
  complexityResetAt?: number | Date
}
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (
  opts?: RatelimitedLinearErrorOpts,
) => Error
const NetworkLinearError = RealNetworkLinearError as unknown as new (msg?: string) => Error
const AuthenticationLinearError = RealAuthenticationLinearError as unknown as new (
  msg?: string,
) => Error
const InvalidInputLinearError = RealInvalidInputLinearError as unknown as new (
  msg?: string,
) => Error
const InternalLinearError = RealInternalLinearError as unknown as new (msg?: string) => Error

// Deterministic seam: random returns 0.5 so every jittered sleep equals
// `base * 1.5` (base + 0.5*base). Sleep is a vi.fn that resolves immediately.
function makeSeams() {
  return {
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0.5,
  }
}

describe('withRateLimitRetry — happy paths', () => {
  it('Test 1: returns the call result on first success', async () => {
    const result = await withRateLimitRetry(async () => 'ok', makeSeams())
    expect(result).toBe('ok')
  })
})

describe('withRateLimitRetry — RatelimitedLinearError retry behavior', () => {
  it('Test 2: retries up to 3 attempts with full jitter at base=250 doubling', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError()
    })
    await expect(withRateLimitRetry(call, seams)).rejects.toBeInstanceOf(LinearAgentError)
    expect(call).toHaveBeenCalledTimes(3)
    // 2 sleeps between 3 attempts. With random=0.5: base + 0.5*base = 1.5 * base.
    // attempt=0: base=250 -> 375; attempt=1: base=500 -> 750.
    expect(seams.sleep).toHaveBeenCalledTimes(2)
    expect(seams.sleep).toHaveBeenNthCalledWith(1, 375)
    expect(seams.sleep).toHaveBeenNthCalledWith(2, 750)
  })

  it('Test 3: after 3 rate-limit retries exhaust, throws LinearAgentError(RATELIMITED) with retryAfterMs default 30000 and details forwarded', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError({
        complexityRemaining: 1500,
        complexityLimit: 250000,
      })
    })
    expect.assertions(5)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RATELIMITED')
      expect(err.transient).toBe(true)
      expect(err.retryAfterMs).toBe(30_000)
      expect(err.details).toEqual({ complexityRemaining: 1500, complexityLimit: 250000 })
    }
  })

  it('Test 4: when err.retryAfter is present, sleeps Math.min(retryAfter*1000, base*4) on the first retry', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError({ retryAfter: 5 })
    })
    await expect(withRateLimitRetry(call, seams)).rejects.toBeInstanceOf(LinearAgentError)
    // attempt=0 base=250, base*4=1000, retryAfter*1000=5000 → min=1000
    expect(seams.sleep).toHaveBeenNthCalledWith(1, 1000)
    // attempt=1 base=500, base*4=2000, retryAfter*1000=5000 → min=2000
    expect(seams.sleep).toHaveBeenNthCalledWith(2, 2000)
  })
})

describe('withRateLimitRetry — NetworkLinearError retry behavior', () => {
  it('Test 5: retries up to 3 attempts with base=100 doubling, then surfaces NETWORK_ERROR (transient)', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new NetworkLinearError()
    })
    expect.assertions(5)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('NETWORK_ERROR')
      expect(err.transient).toBe(true)
      // 2 sleeps: attempt=0 base=100 → 150; attempt=1 base=200 → 300.
      expect(seams.sleep).toHaveBeenNthCalledWith(1, 150)
      expect(seams.sleep).toHaveBeenNthCalledWith(2, 300)
    }
  })
})

describe('withRateLimitRetry — non-retryable errors surface immediately', () => {
  it('Test 6: AuthenticationLinearError surfaces as AUTH_INVALID with NO retry', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new AuthenticationLinearError()
    })
    expect.assertions(4)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('AUTH_INVALID')
      expect(call).toHaveBeenCalledTimes(1)
      expect(seams.sleep).not.toHaveBeenCalled()
    }
  })

  it('Test 7: InvalidInputLinearError surfaces as VALIDATION_FAILED with details.cause carrying the SDK message', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new InvalidInputLinearError('Argument value is not valid: filter.state.name')
    })
    expect.assertions(4)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details).toEqual({ cause: 'Argument value is not valid: filter.state.name' })
      expect(call).toHaveBeenCalledTimes(1)
    }
  })

  it('Test 8: arbitrary LinearError subclass surfaces as LINEAR_API_ERROR', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new InternalLinearError('boom')
    })
    expect.assertions(3)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(err.details?.cause).toBe('boom')
    }
  })

  it('Test 9: non-Linear error (programming bug) surfaces as LINEAR_API_ERROR with details.cause', async () => {
    const seams = makeSeams()
    const call = vi.fn().mockImplementation(async () => {
      throw new Error('plain old programming error')
    })
    expect.assertions(3)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(err.details?.cause).toBe('plain old programming error')
    }
  })

  it('Test 10: a LinearAgentError thrown by the inner call passes through unchanged (idempotent)', async () => {
    const seams = makeSeams()
    const original = LinearAgentError.workspace.notFound('acme')
    const call = vi.fn().mockImplementation(async () => {
      throw original
    })
    expect.assertions(2)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBe(original)
      expect(call).toHaveBeenCalledTimes(1)
    }
  })
})

describe('withRateLimitRetry — RetryOpts knobs', () => {
  it('Test 11: maxAttempts=1 disables retry entirely (one attempt, then surface)', async () => {
    const seams = { ...makeSeams(), maxAttempts: 1 }
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError()
    })
    expect.assertions(3)
    try {
      await withRateLimitRetry(call, seams)
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect(call).toHaveBeenCalledTimes(1)
      expect(seams.sleep).not.toHaveBeenCalled()
    }
  })

  it('Test 12: custom opts.sleep is used when supplied', async () => {
    const customSleep = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockImplementation(async () => {
      throw new RatelimitedLinearError()
    })
    await expect(
      withRateLimitRetry(call, { sleep: customSleep, random: () => 0 }),
    ).rejects.toBeInstanceOf(LinearAgentError)
    expect(customSleep).toHaveBeenCalled()
  })
})

describe('classifySdkError — direct usage', () => {
  it('Test 13: RatelimitedLinearError → LinearAgentError(RATELIMITED) with details forwarded', () => {
    const sdkErr = new RatelimitedLinearError({
      retryAfter: 7,
      complexityRemaining: 99,
      complexityLimit: 250000,
    })
    const out = classifySdkError(sdkErr)
    expect(out).toBeInstanceOf(LinearAgentError)
    expect(out.code).toBe('RATELIMITED')
    expect(out.retryAfterMs).toBe(7000)
    expect(out.details).toEqual({ complexityRemaining: 99, complexityLimit: 250000 })
  })

  it('Test 14: arbitrary Error → LINEAR_API_ERROR with details.cause = err.message', () => {
    const out = classifySdkError(new Error('generic boom'))
    expect(out.code).toBe('LINEAR_API_ERROR')
    expect(out.details).toEqual({ cause: 'generic boom' })
  })

  it('Test 15: a LinearAgentError instance passes through (idempotent)', () => {
    const original = LinearAgentError.network('dns timeout')
    const out = classifySdkError(original)
    expect(out).toBe(original)
  })
})
