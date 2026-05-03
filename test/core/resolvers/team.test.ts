/**
 * Unit tests for `resolveTeamId` (Phase 2 PLAN 02-02 Task 1).
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
import { _clearTeamCache, resolveTeamId } from '@/core/resolvers/team.js'

interface TeamNode {
  id: string
  key: string
  name: string
}

function makeClient(teams: TeamNode[]) {
  const teamsFn = vi.fn(async () => ({ nodes: teams }))
  return {
    client: { teams: teamsFn } as unknown as LinearClient,
    teams: teamsFn,
  }
}

const TEAM_UUID = '11111111-2222-3333-4444-555555555555'

describe('resolveTeamId', () => {
  beforeEach(() => {
    _clearTeamCache()
  })

  it('Test 10: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, teams } = makeClient([])
    const id = await resolveTeamId(client, 'acme', TEAM_UUID)
    expect(id).toBe(TEAM_UUID)
    expect(teams).not.toHaveBeenCalled()
  })

  it('Test 11: team key — case-insensitive, calls teams() and returns matching id', async () => {
    const { client, teams } = makeClient([
      { id: 'team-eng-id', key: 'ENG', name: 'Engineering' },
      { id: 'team-design-id', key: 'DSGN', name: 'Design' },
    ])
    const id = await resolveTeamId(client, 'acme', 'ENG')
    expect(id).toBe('team-eng-id')
    expect(teams).toHaveBeenCalledTimes(1)
    // Cached: a lowercase key still hits cache, no second SDK call.
    const id2 = await resolveTeamId(client, 'acme', 'eng')
    expect(id2).toBe('team-eng-id')
    expect(teams).toHaveBeenCalledTimes(1)
  })

  it('Test 12: team name — case-insensitive, returns matching id', async () => {
    const { client } = makeClient([
      { id: 'team-eng-id', key: 'ENG', name: 'Engineering' },
      { id: 'team-design-id', key: 'DSGN', name: 'Design' },
    ])
    expect(await resolveTeamId(client, 'acme', 'Engineering')).toBe('team-eng-id')
    _clearTeamCache()
    expect(await resolveTeamId(client, 'acme', 'engineering')).toBe('team-eng-id')
  })

  it('Test 13: cache by workspace — repeated calls trigger ONE SDK call across N requests', async () => {
    const { client, teams } = makeClient([
      { id: 'team-eng-id', key: 'ENG', name: 'Engineering' },
      { id: 'team-design-id', key: 'DSGN', name: 'Design' },
    ])
    await resolveTeamId(client, 'acme', 'ENG')
    await resolveTeamId(client, 'acme', 'DSGN')
    await resolveTeamId(client, 'acme', 'Engineering')
    expect(teams).toHaveBeenCalledTimes(1)
  })

  it('Test 14: miss — throws TEAM_NOT_FOUND with workspace, requested, and available keys/names', async () => {
    const { client } = makeClient([
      { id: 'team-eng-id', key: 'ENG', name: 'Engineering' },
      { id: 'team-design-id', key: 'DSGN', name: 'Design' },
    ])
    try {
      await resolveTeamId(client, 'acme', 'BogusTeam')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('TEAM_NOT_FOUND')
      expect(err.message).toMatch(/team not found: BogusTeam/)
      expect(err.details).toEqual({
        workspace: 'acme',
        requested: 'BogusTeam',
        availableKeys: ['dsgn', 'eng'],
        availableNames: ['design', 'engineering'],
      })
    }
  })
})
