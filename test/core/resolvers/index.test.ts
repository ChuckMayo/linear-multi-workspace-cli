/**
 * Barrel-export coverage for `src/core/resolvers/index.ts` (Phase 2 PLAN 02-02
 * Task 2). Pin the 12 named exports (6 resolvers + 6 cache-clear seams) so the
 * downstream plans (02-03 issue transition, 02-04 issue create/update, 02-07
 * project update-status) can import any resolver from a single module.
 */
import { describe, expect, it } from 'vitest'

import * as resolvers from '@/core/resolvers/index.js'

describe('resolvers barrel', () => {
  it('Test 19: exports all 6 resolver functions and 6 cache-clear seams', () => {
    const expected = [
      // public resolvers
      'resolveStateNameToId',
      'resolveTeamId',
      'resolveLabelId',
      'resolveLabelIds',
      'resolveProjectId',
      'resolveProjectStatusId',
      'resolveCycleId',
      // test seams
      '_clearStateCache',
      '_clearTeamCache',
      '_clearLabelCache',
      '_clearProjectCache',
      '_clearProjectStatusCache',
      '_clearCycleCache',
    ].sort()
    const actual = Object.keys(resolvers).sort()
    expect(actual).toEqual(expected)
    for (const name of expected) {
      expect(typeof (resolvers as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
