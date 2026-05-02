import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ERROR_CODES,
  EXIT_CODES,
  exitCodeFor,
  LinearAgentError,
  type ErrorCode,
} from '@/core/errors/index.js'

describe('LinearAgentError', () => {
  it('is constructible with required fields and is an instanceof Error', () => {
    const err = new LinearAgentError({
      code: 'WORKSPACE_NOT_RESOLVED',
      message: 'no workspace selected',
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LinearAgentError)
    expect(err.code).toBe('WORKSPACE_NOT_RESOLVED')
    expect(err.message).toBe('no workspace selected')
    expect(err.transient).toBe(false)
    expect(err.retryAfterMs).toBeUndefined()
    expect(err.details).toBeUndefined()
    expect(err.name).toBe('LinearAgentError')
  })

  it('exposes optional retryAfterMs and details', () => {
    const err = new LinearAgentError({
      code: 'RATELIMITED',
      message: 'slow down',
      retryAfterMs: 30_000,
      details: { complexityRemaining: 0 },
    })
    expect(err.retryAfterMs).toBe(30_000)
    expect(err.details).toEqual({ complexityRemaining: 0 })
  })

  it('defaults transient=true for rate-limit and network families', () => {
    expect(new LinearAgentError({ code: 'RATELIMITED', message: 'slow' }).transient).toBe(true)
    expect(new LinearAgentError({ code: 'NETWORK_ERROR', message: 'dns' }).transient).toBe(true)
  })

  it('defaults transient=false for non-transient families', () => {
    expect(
      new LinearAgentError({ code: 'WORKSPACE_NOT_RESOLVED', message: 'x' }).transient,
    ).toBe(false)
    expect(new LinearAgentError({ code: 'AUTH_INVALID', message: 'x' }).transient).toBe(false)
    expect(new LinearAgentError({ code: 'VALIDATION_FAILED', message: 'x' }).transient).toBe(false)
    expect(new LinearAgentError({ code: 'LINEAR_API_ERROR', message: 'x' }).transient).toBe(false)
    expect(new LinearAgentError({ code: 'GENERIC_ERROR', message: 'x' }).transient).toBe(false)
    expect(new LinearAgentError({ code: 'USAGE_ERROR', message: 'x' }).transient).toBe(false)
  })

  it('honors an explicit transient override', () => {
    expect(
      new LinearAgentError({ code: 'LINEAR_API_ERROR', message: 'x', transient: true }).transient,
    ).toBe(true)
    expect(
      new LinearAgentError({ code: 'RATELIMITED', message: 'x', transient: false }).transient,
    ).toBe(false)
  })

  it('refuses lin_api_ token-shaped substrings in message', () => {
    expect(
      () =>
        new LinearAgentError({
          code: 'AUTH_INVALID',
          message: 'token lin_api_abc123 was rejected',
        }),
    ).toThrowError(/token-shaped substring forbidden/)
  })

  it('refuses lin_oauth_ token-shaped substrings in message', () => {
    expect(
      () =>
        new LinearAgentError({
          code: 'AUTH_INVALID',
          message: 'oauth lin_oauth_xyz expired',
        }),
    ).toThrowError(/token-shaped substring forbidden/)
  })

  it('exposes static family helpers for ergonomics', () => {
    const w = LinearAgentError.workspace.notResolved()
    expect(w).toBeInstanceOf(LinearAgentError)
    expect(w.code).toBe('WORKSPACE_NOT_RESOLVED')

    const a = LinearAgentError.auth.invalid()
    expect(a.code).toBe('AUTH_INVALID')

    const v = LinearAgentError.validation.failed('bad input')
    expect(v.code).toBe('VALIDATION_FAILED')
    expect(v.message).toContain('bad input')

    const r = LinearAgentError.rateLimited(30_000)
    expect(r.code).toBe('RATELIMITED')
    expect(r.transient).toBe(true)
    expect(r.retryAfterMs).toBe(30_000)

    const n = LinearAgentError.network('dns failure')
    expect(n.code).toBe('NETWORK_ERROR')
    expect(n.transient).toBe(true)

    const l = LinearAgentError.linear.apiError({ message: 'server said no' })
    expect(l.code).toBe('LINEAR_API_ERROR')
  })
})

describe('ERROR_CODES tuple', () => {
  it('contains every code in the taxonomy', () => {
    const expected = [
      'WORKSPACE_NOT_RESOLVED',
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_REQUIRED_FOR_WRITE',
      'WORKSPACE_TOKEN_MISMATCH',
      'WORKSPACE_ALREADY_EXISTS',
      'AUTH_INVALID',
      'CONFIG_PERMISSIONS_TOO_BROAD',
      'CONFIG_NOT_FOUND',
      'VALIDATION_FAILED',
      'INVALID_FIELD',
      'LINEAR_API_ERROR',
      'RATELIMITED',
      'NETWORK_ERROR',
      'USAGE_ERROR',
      'GENERIC_ERROR',
    ] as const
    for (const c of expected) {
      expect(ERROR_CODES).toContain(c)
    }
    expect(ERROR_CODES.length).toBe(expected.length)
  })

  it('the ErrorCode type is the element-union of ERROR_CODES', () => {
    // Compile-time check via expectTypeOf — fails typecheck if ErrorCode drifts.
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[number]>()
  })
})

describe('exitCodeFor', () => {
  it('maps every workspace family code to 10', () => {
    expect(exitCodeFor('WORKSPACE_NOT_RESOLVED')).toBe(10)
    expect(exitCodeFor('WORKSPACE_NOT_FOUND')).toBe(10)
    expect(exitCodeFor('WORKSPACE_REQUIRED_FOR_WRITE')).toBe(10)
    expect(exitCodeFor('WORKSPACE_TOKEN_MISMATCH')).toBe(10)
    expect(exitCodeFor('WORKSPACE_ALREADY_EXISTS')).toBe(10)
  })

  it('maps every auth family code to 11', () => {
    expect(exitCodeFor('AUTH_INVALID')).toBe(11)
    expect(exitCodeFor('CONFIG_PERMISSIONS_TOO_BROAD')).toBe(11)
    expect(exitCodeFor('CONFIG_NOT_FOUND')).toBe(11)
  })

  it('maps every validation family code to 12', () => {
    expect(exitCodeFor('VALIDATION_FAILED')).toBe(12)
    expect(exitCodeFor('INVALID_FIELD')).toBe(12)
  })

  it('maps Linear-API to 13, rate-limit to 14, network to 15', () => {
    expect(exitCodeFor('LINEAR_API_ERROR')).toBe(13)
    expect(exitCodeFor('RATELIMITED')).toBe(14)
    expect(exitCodeFor('NETWORK_ERROR')).toBe(15)
  })

  it('maps usage to 2 and generic to 1', () => {
    expect(exitCodeFor('USAGE_ERROR')).toBe(2)
    expect(exitCodeFor('GENERIC_ERROR')).toBe(1)
  })

  it('returns 1 only for GENERIC_ERROR (no implicit fallback)', () => {
    // Sanity — every defined code has a dedicated branch; the only one that returns 1 is GENERIC.
    let ones = 0
    for (const c of ERROR_CODES) {
      if (exitCodeFor(c) === 1) ones++
    }
    expect(ones).toBe(1)
    expect(exitCodeFor('GENERIC_ERROR')).toBe(1)
  })
})

describe('EXIT_CODES const map', () => {
  it('declares the canonical numeric ranges', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      GENERIC: 1,
      USAGE: 2,
      WORKSPACE: 10,
      AUTH: 11,
      VALIDATION: 12,
      LINEAR_API: 13,
      RATELIMITED: 14,
      NETWORK: 15,
    })
  })

  it('stays under the POSIX-reserved 64+ range', () => {
    for (const v of Object.values(EXIT_CODES)) {
      expect(v).toBeLessThan(64)
    }
  })
})
