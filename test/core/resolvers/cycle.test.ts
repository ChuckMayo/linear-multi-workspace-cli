/**
 * Unit tests for `resolveCycleId` (Phase 2 PLAN 02-02 Task 2).
 *
 * Cycle resolver accepts:
 *   - UUID         — passthrough
 *   - 'current' / '0'   — active cycle
 *   - 'next' / '+1'     — index after active in number-sorted list
 *   - 'previous' / '-1' — index before active
 *   - '+N' / '-N'       — arbitrary offset against active index
 *   - cycle.name        — name lookup (cycle names are optional)
 *
 * Cache is per `${workspace}:${teamId}` and stores the full ordered cycle
 * list; once warm, all ref shapes resolve client-side without further SDK
 * round-trips.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    constructor(opts?: { message?: string; retryAfter?: number }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
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

import type { LinearClient } from '@linear/sdk'

import { LinearAgentError } from '@/core/errors/index.js'
import { _clearCycleCache, resolveCycleId } from '@/core/resolvers/cycle.js'

interface CycleFixtureNode {
  id: string
  number: number
  name?: string | null
  isActive?: boolean
}

const TEAM_A = 'team-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CYCLE_UUID = 'cccccccc-1111-2222-3333-444444444444'

/**
 * Make a `LinearClient`-shaped mock where:
 *   - `client.team(teamId)` resolves to a mock Team object.
 *   - `team.cycles(args)` returns the cycle connection.
 *
 * Cycles can be returned in any order; the resolver sorts by number ascending.
 */
function makeClient(cyclesIn: CycleFixtureNode[]) {
  const cyclesFn = vi.fn(async () => ({ nodes: cyclesIn }))
  const teamFn = vi.fn(async (_id: string) => ({ cycles: cyclesFn }))
  const client = { team: teamFn } as unknown as LinearClient
  return { client, teamFn, cyclesFn }
}

// Standard fixture: 4 cycles numbered 10-13, with #12 marked active.
function fourCyclesActiveAt12(): CycleFixtureNode[] {
  return [
    { id: 'cycle-13', number: 13, name: 'Sprint Lambda' },
    { id: 'cycle-11', number: 11, name: 'Sprint Beta', isActive: false },
    { id: 'cycle-12', number: 12, name: null, isActive: true },
    { id: 'cycle-10', number: 10, name: 'Sprint Alpha' },
  ]
}

describe('resolveCycleId', () => {
  beforeEach(() => {
    _clearCycleCache()
  })

  it('Test 9: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, teamFn, cyclesFn } = makeClient([])
    const id = await resolveCycleId(client, 'acme', TEAM_A, CYCLE_UUID)
    expect(id).toBe(CYCLE_UUID)
    expect(teamFn).not.toHaveBeenCalled()
    expect(cyclesFn).not.toHaveBeenCalled()
  })

  it('Test 10: "current" → active cycle id', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, 'current')).toBe('cycle-12')
  })

  it('Test 11: "next" → cycle one index after active in number-sorted order (cycle 13)', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, 'next')).toBe('cycle-13')
  })

  it('Test 12: "previous" → cycle one index before active in number-sorted order (cycle 11)', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, 'previous')).toBe('cycle-11')
  })

  it('Test 13: "+1" — synonym for "next"', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, '+1')).toBe('cycle-13')
  })

  it('Test 14: "-1" — synonym for "previous"', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, '-1')).toBe('cycle-11')
  })

  it('Test 15: "+2" — two indices after active when in range', async () => {
    // Add an extra cycle 14 so +2 from active index (cycle 12 → cycle 14) is valid.
    const cycles: CycleFixtureNode[] = [
      ...fourCyclesActiveAt12(),
      { id: 'cycle-14', number: 14, name: 'Sprint Mu' },
    ]
    const { client } = makeClient(cycles)
    expect(await resolveCycleId(client, 'acme', TEAM_A, '+2')).toBe('cycle-14')
  })

  it('Test 16: "0" — synonym for "current" → active cycle id', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, '0')).toBe('cycle-12')
  })

  it('Test 17: cache by workspace+teamId — multiple ref resolutions trigger ONE bulk fetch', async () => {
    const { client, teamFn, cyclesFn } = makeClient(fourCyclesActiveAt12())
    await resolveCycleId(client, 'acme', TEAM_A, 'current')
    await resolveCycleId(client, 'acme', TEAM_A, 'next')
    await resolveCycleId(client, 'acme', TEAM_A, 'previous')
    await resolveCycleId(client, 'acme', TEAM_A, '+1')
    await resolveCycleId(client, 'acme', TEAM_A, 'Sprint Beta')
    expect(teamFn).toHaveBeenCalledTimes(1)
    expect(cyclesFn).toHaveBeenCalledTimes(1)
  })

  it('Test 18: missing offset target — out-of-range "+2" with no active+2 cycle throws CYCLE_NOT_FOUND with availableNumbers + activeNumber', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    try {
      await resolveCycleId(client, 'acme', TEAM_A, '+2')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('CYCLE_NOT_FOUND')
      expect(err.message).toMatch(/cycle not found: \+2/)
      expect(err.details).toEqual({
        teamId: TEAM_A,
        requested: '+2',
        availableNumbers: [10, 11, 12, 13],
        activeNumber: 12,
      })
    }
  })

  it('Test 18b: no active cycle — "current" throws CYCLE_NOT_FOUND with activeNumber: null', async () => {
    const cycles: CycleFixtureNode[] = [
      { id: 'cycle-10', number: 10, isActive: false },
      { id: 'cycle-11', number: 11, isActive: false },
    ]
    const { client } = makeClient(cycles)
    try {
      await resolveCycleId(client, 'acme', TEAM_A, 'current')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('CYCLE_NOT_FOUND')
      expect(err.details).toEqual({
        teamId: TEAM_A,
        requested: 'current',
        availableNumbers: [10, 11],
        activeNumber: null,
      })
    }
  })

  it('Test 18c: name lookup — cycle.name match returns id', async () => {
    const { client } = makeClient(fourCyclesActiveAt12())
    expect(await resolveCycleId(client, 'acme', TEAM_A, 'Sprint Alpha')).toBe('cycle-10')
    expect(await resolveCycleId(client, 'acme', TEAM_A, 'sprint alpha')).toBe('cycle-10')
  })
})
