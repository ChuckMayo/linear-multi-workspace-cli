/**
 * Pagination module tests (Phase 1 PLAN-05, KRN-08).
 *
 * Covers parsePagination() runtime validation and the PAGINATION_FLAGS oclif
 * Flags fragment shape (defaults + min/max bounds).
 */
import { describe, expect, it } from 'vitest'
import { LinearAgentError } from '@/core/errors/index.js'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PAGINATION_FLAGS,
  parsePagination,
} from '@/core/pagination/index.js'

describe('parsePagination()', () => {
  it('Test 14: parsePagination({ limit: 5, cursor: "abc" }) returns { first: 5, after: "abc" }', () => {
    expect(parsePagination({ limit: 5, cursor: 'abc' })).toEqual({ first: 5, after: 'abc' })
  })

  it('Test 15: parsePagination({}) returns the documented defaults', () => {
    expect(parsePagination({})).toEqual({ first: DEFAULT_LIMIT, after: undefined })
    expect(DEFAULT_LIMIT).toBe(25)
  })

  it('Test 16: parsePagination({ limit: 200 }) throws USAGE_ERROR', () => {
    expect.assertions(3)
    try {
      parsePagination({ limit: 200 })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/100/)
    }
  })

  it('Test 17: parsePagination({ limit: 0 }) throws USAGE_ERROR', () => {
    expect(() => parsePagination({ limit: 0 })).toThrow(LinearAgentError)
    try {
      parsePagination({ limit: 0 })
    } catch (e) {
      expect((e as LinearAgentError).code).toBe('USAGE_ERROR')
    }
  })

  it('Test 18: parsePagination({ limit: -1 }) throws USAGE_ERROR', () => {
    expect(() => parsePagination({ limit: -1 })).toThrow(LinearAgentError)
    try {
      parsePagination({ limit: -1 })
    } catch (e) {
      expect((e as LinearAgentError).code).toBe('USAGE_ERROR')
    }
  })
})

describe('PAGINATION_FLAGS', () => {
  it('Test 19: PAGINATION_FLAGS exports limit (default 25, min 1, max 100) and cursor (string)', () => {
    expect(MAX_LIMIT).toBe(100)
    // oclif Flags returns option-parser objects with default/min/max as top-level
    // fields. We assert the bounds match the kernel contract; the exact wrapper
    // shape is oclif-internal but stable across patch versions in v4.
    const limit = PAGINATION_FLAGS.limit as unknown as {
      default?: number
      min?: number
      max?: number
      type?: string
    }
    expect(limit.type).toBe('option')
    expect(limit.default).toBe(25)
    expect(limit.min).toBe(1)
    expect(limit.max).toBe(100)
    // cursor is a string flag — has no default
    const cursor = PAGINATION_FLAGS.cursor as unknown as { default?: string; type?: string }
    expect(cursor.type).toBe('option')
    expect(cursor.default).toBeUndefined()
  })
})
