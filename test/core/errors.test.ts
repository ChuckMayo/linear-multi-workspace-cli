import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ERROR_CODES,
  type ErrorCode,
  EXIT_CODES,
  exitCodeFor,
  LinearAgentError,
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
    expect(new LinearAgentError({ code: 'WORKSPACE_NOT_RESOLVED', message: 'x' }).transient).toBe(
      false,
    )
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
      // Phase 2 PLAN 02-01 additions
      'VALIDATION_NO_FIELDS',
      'WORKFLOW_TEAM_REQUIRED',
      'CONFIRMATION_REQUIRED',
      'WORKFLOW_STATE_NOT_FOUND',
      'ISSUE_NOT_FOUND',
      'LABEL_NOT_FOUND',
      'TEAM_NOT_FOUND',
      'PROJECT_NOT_FOUND',
      'CYCLE_NOT_FOUND',
      // Phase 3 PLAN 03-01 additions
      'RAW_OPERATION_NOT_FOUND',
      'RAW_MUTATION_REQUIRES_FLAG',
      'OPERATION_SUBSCRIPTIONS_UNSUPPORTED',
      'GRAPHQL_QUERY_FILE_NOT_FOUND',
      'BATCH_REQUIRES_YES',
      'INVALID_INCLUDE',
      'RAW_VARS_INVALID',
      'GRAPHQL_VALIDATION_FAILED',
      'BATCH_PLAN_INVALID',
      // Phase 4 PLAN 04-01 additions
      'DESCRIBE_COMMAND_NOT_FOUND',
    ] as const
    for (const c of expected) {
      expect(ERROR_CODES).toContain(c)
    }
    expect(ERROR_CODES.length).toBe(expected.length)
  })

  it('Phase 2 Test 1 (RED): tuple includes 9 new Phase 2 literals', () => {
    expect(ERROR_CODES).toContain('VALIDATION_NO_FIELDS')
    expect(ERROR_CODES).toContain('WORKFLOW_STATE_NOT_FOUND')
    expect(ERROR_CODES).toContain('ISSUE_NOT_FOUND')
    expect(ERROR_CODES).toContain('LABEL_NOT_FOUND')
    expect(ERROR_CODES).toContain('TEAM_NOT_FOUND')
    expect(ERROR_CODES).toContain('PROJECT_NOT_FOUND')
    expect(ERROR_CODES).toContain('CYCLE_NOT_FOUND')
    expect(ERROR_CODES).toContain('WORKFLOW_TEAM_REQUIRED')
    expect(ERROR_CODES).toContain('CONFIRMATION_REQUIRED')
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

  // ─── Phase 2 PLAN 02-01 Tests 2-7 ────────────────────────────────────
  it('Phase 2 Test 2: VALIDATION_NO_FIELDS maps to USAGE (exit 2)', () => {
    expect(exitCodeFor('VALIDATION_NO_FIELDS')).toBe(2)
  })
  it('Phase 2 Test 3: WORKFLOW_TEAM_REQUIRED maps to USAGE (exit 2)', () => {
    expect(exitCodeFor('WORKFLOW_TEAM_REQUIRED')).toBe(2)
  })
  it('Phase 2 Test 4: CONFIRMATION_REQUIRED maps to USAGE (exit 2)', () => {
    expect(exitCodeFor('CONFIRMATION_REQUIRED')).toBe(2)
  })
  it('Phase 2 Test 5: WORKFLOW_STATE_NOT_FOUND maps to LINEAR_API (exit 13)', () => {
    expect(exitCodeFor('WORKFLOW_STATE_NOT_FOUND')).toBe(13)
  })
  it('Phase 2 Test 6: ISSUE_NOT_FOUND maps to LINEAR_API (exit 13)', () => {
    expect(exitCodeFor('ISSUE_NOT_FOUND')).toBe(13)
  })
  it('Phase 2 Test 7: LABEL/TEAM/PROJECT/CYCLE_NOT_FOUND all map to exit 13', () => {
    expect(exitCodeFor('LABEL_NOT_FOUND')).toBe(13)
    expect(exitCodeFor('TEAM_NOT_FOUND')).toBe(13)
    expect(exitCodeFor('PROJECT_NOT_FOUND')).toBe(13)
    expect(exitCodeFor('CYCLE_NOT_FOUND')).toBe(13)
  })

  // ─── Phase 3 PLAN 03-01 Test 4 — table-driven 9-code exit mapping ────
  // Per CONTEXT.md § Decisions line 58: 6 codes -> USAGE (2), 3 -> VALIDATION (12).
  describe('Phase 3 PLAN 03-01: 9 new codes map to existing exit numbers', () => {
    const cases: Array<[ErrorCode, number]> = [
      ['RAW_OPERATION_NOT_FOUND', 2],
      ['RAW_MUTATION_REQUIRES_FLAG', 2],
      ['OPERATION_SUBSCRIPTIONS_UNSUPPORTED', 2],
      ['GRAPHQL_QUERY_FILE_NOT_FOUND', 2],
      ['BATCH_REQUIRES_YES', 2],
      ['INVALID_INCLUDE', 2],
      ['RAW_VARS_INVALID', 12],
      ['GRAPHQL_VALIDATION_FAILED', 12],
      ['BATCH_PLAN_INVALID', 12],
    ]
    for (const [code, expected] of cases) {
      it(`${code} -> exit ${expected}`, () => {
        expect(exitCodeFor(code)).toBe(expected)
      })
    }
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
