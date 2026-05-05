/**
 * Unit tests for `src/lib/include-fragments.ts` (Phase 3 PLAN 03-04, RAW-04).
 *
 * Verifies INCLUDE_FRAGMENT_MAP shape + validateAndMergeIncludes behavior:
 *   1. Valid keys for 'issue list' returns merged fragment text containing both fragments.
 *   2. Unknown key throws INVALID_INCLUDE (exit 2) with details.allowed + details.unknown.
 *   3. Empty array input returns '' (contract pin -- runtimes branch BEFORE calling).
 *   4. Valid key for 'cycle list' returns the cycle-issues fragment.
 *   5. Every CommandName in INCLUDE_FRAGMENT_MAP has a non-empty allowed map.
 *
 * Failure-envelope snapshot for INVALID_INCLUDE: Test 2 snapshots the full envelope.
 * Per-runtime tests (8a-e) only assert error.code + exit (shape is identical, only
 * meta.command varies).
 */
import { describe, expect, it } from 'vitest'

import { LinearAgentError } from '@/core/errors/index.js'
import { exitCodeFor } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { INCLUDE_FRAGMENT_MAP, validateAndMergeIncludes } from '@/lib/include-fragments.js'

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue list' })
}

describe('INCLUDE_FRAGMENT_MAP -- shape', () => {
  it('Test 5: every CommandName has a non-empty allowed map with non-empty fragment strings', () => {
    const entries = Object.entries(INCLUDE_FRAGMENT_MAP)
    expect(entries.length).toBeGreaterThan(0)
    for (const [commandName, fragmentMap] of entries) {
      const keys = Object.keys(fragmentMap)
      expect(keys.length, `${commandName} must have at least one include key`).toBeGreaterThan(0)
      for (const [key, fragment] of Object.entries(fragmentMap)) {
        expect(typeof fragment, `${commandName}.${key} fragment must be a string`).toBe('string')
        expect(
          (fragment as string).length,
          `${commandName}.${key} fragment must be non-empty`,
        ).toBeGreaterThan(0)
      }
    }
  })
})

describe('validateAndMergeIncludes -- happy paths', () => {
  it('Test 1: valid keys ["comments", "labels"] for "issue list" returns merged fragment text', () => {
    const result = validateAndMergeIncludes('issue list', ['comments', 'labels'])
    expect(result).toContain('comments(first: 50)')
    expect(result).toContain('labels(first: 50)')
    expect(result).toMatchSnapshot('issue-list-comments-labels')
  })

  it('Test 3: empty array returns empty string', () => {
    const result = validateAndMergeIncludes('issue list', [])
    expect(result).toBe('')
  })

  it('Test 4: valid key ["issues"] for "cycle list" returns cycle-issues fragment', () => {
    const result = validateAndMergeIncludes('cycle list', ['issues'])
    expect(result).toContain('issues(first: 50)')
    expect(result).toMatchSnapshot('cycle-list-issues')
  })
})

describe('validateAndMergeIncludes -- INVALID_INCLUDE', () => {
  it('Test 2: unknown key throws INVALID_INCLUDE with details.allowed (sorted) + details.unknown', () => {
    expect.assertions(6)
    try {
      validateAndMergeIncludes('issue list', ['nonexistentKey'])
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('INVALID_INCLUDE')
      const details = err.details as { allowed: string[]; unknown: string[] }
      // allowed should be sorted alphabetically
      expect(details.allowed).toEqual([
        'attachments',
        'comments',
        'history',
        'labels',
        'subscribers',
      ])
      expect(details.unknown).toEqual(['nonexistentKey'])
      // Exit code must be 2 (USAGE family)
      expect(exitCodeFor(err.code)).toBe(2)
      // Snapshot the canonical failure envelope for INVALID_INCLUDE
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-INVALID_INCLUDE')
    }
  })
})
