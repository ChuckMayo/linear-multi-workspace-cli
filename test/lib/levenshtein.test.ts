import { describe, expect, it } from 'vitest'
import { levenshtein, suggestClosest } from '../../src/lib/levenshtein.js'

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0)
  })

  it('returns string length when other is empty', () => {
    expect(levenshtein('a', '')).toBe(1)
    expect(levenshtein('', 'a')).toBe(1)
    expect(levenshtein('abc', '')).toBe(3)
  })

  it('returns 3 for kitten -> sitting', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })

  it('returns 1 for single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1)
  })

  it('returns 1 for single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1)
  })

  it('returns 1 for single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1)
  })

  it('is case-sensitive', () => {
    expect(levenshtein('ABC', 'abc')).toBe(3)
  })
})

describe('suggestClosest', () => {
  it('returns exact match first (distance 0)', () => {
    const result = suggestClosest('Issues', ['Issues', 'IssueCreate', 'IssueDelete'], 2)
    expect(result[0]).toBe('Issues')
    expect(result.length).toBe(2)
  })

  it('returns closest names first by distance', () => {
    const result = suggestClosest('IssueList', ['Issues', 'IssueCreate'], 2)
    expect(result).toHaveLength(2)
    // Both returned, closest-match ordering
    const d1 = levenshtein('issuelist', 'issues')
    const d2 = levenshtein('issuelist', 'issuecreate')
    // Verify the order matches ascending distance
    expect(d1).toBeLessThanOrEqual(d2)
    expect(result[0]).toBe('Issues')
  })

  it('respects the limit parameter', () => {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
    const result = suggestClosest('Alp', names, 2)
    expect(result).toHaveLength(2)
  })

  it('is case-insensitive in comparison', () => {
    // 'issues' (lowercase) vs 'Issues' (capitalized) — should still find it as closest
    const result = suggestClosest('issues', ['Issues', 'IssueCreate'], 1)
    expect(result[0]).toBe('Issues')
  })

  it('returns up to limit entries even if fewer names exist', () => {
    const result = suggestClosest('abc', ['xyz'], 5)
    expect(result).toHaveLength(1)
  })

  it('defaults to limit=3', () => {
    const names = ['A', 'B', 'C', 'D', 'E']
    const result = suggestClosest('X', names)
    expect(result).toHaveLength(3)
  })
})
