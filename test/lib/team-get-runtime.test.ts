/**
 * `teamGetRuntime` tests (Phase 2 PLAN 02-09 Task 1, TEM-01.get).
 *
 * Coverage:
 *   1. UUID -> client.team(uuid) directly (no filter lookup).
 *   2. Team key -> client.teams({ filter: { key: { eq: 'ENG' } }, first: 1 }) (uppercased).
 *   3. Name fallthrough -> client.teams({ filter: { name: { eq: ... } }, first: 1 }).
 *   4. Empty filter result -> TEAM_NOT_FOUND with details.ref.
 *   5. UUID returns null -> TEAM_NOT_FOUND.
 *   6. Single team in data (not array); meta has NO pageInfo.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
    LinearClient: class MockLinearClient {
      apiKey: string
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
      }
    },
  }
})

import type { LinearClient } from '@linear/sdk'

import TeamGet, { runTeamGet } from '@/commands/team/get.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { teamGetRuntime } from '@/lib/team-get-runtime.js'

const STUB_CONFIG: Config = {
  active: 'acme',
  workspaces: {
    acme: {
      name: 'acme',
      token: 'lin_api_acme_token_xxxxxxxx',
      organizationId: 'org-acme',
      createdAt: '2026-01-01T00:00:00Z',
    },
  },
}

const TEAM_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

interface SdkConnection {
  nodes: Array<Record<string, unknown>>
}

interface MockHandle {
  client: LinearClient
  teamFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  team?: (id: string) => Promise<Record<string, unknown> | null | undefined>
  teams?: (args: Record<string, unknown>) => Promise<SdkConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const teamFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'team', args: [id] })
    if (!opts.team) throw new Error('mock client.team not configured')
    return opts.team(id)
  })
  const teamsFn = vi.fn(async (args: Record<string, unknown>) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams(args)
  })
  const client = { team: teamFn, teams: teamsFn } as unknown as LinearClient
  return { client, teamFn, teamsFn, callLog }
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

const TEAM_FIXTURE: Record<string, unknown> = {
  id: TEAM_UUID,
  key: 'ENG',
  name: 'Engineering',
  description: 'eng team',
  color: '#000',
  private: false,
  createdAt: '2026-01-01T00:00:00Z',
  cycleEnabled: true,
}

describe('teamGetRuntime -- UUID input', () => {
  it('Test 5: UUID -> client.team(uuid) directly (no filter lookup)', async () => {
    const handle = makeMockClient({
      team: async (_id) => TEAM_FIXTURE,
      teams: async () => ({ nodes: [] }),
    })

    const out = await teamGetRuntime({
      args: { ref: TEAM_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamFn).toHaveBeenCalledWith(TEAM_UUID)
    expect(handle.teamsFn).not.toHaveBeenCalled()
    expect(out.data).toBeDefined()
    expect((out.data as Record<string, unknown>).id).toBe(TEAM_UUID)

    const env = success(out.data, { ...out.meta, command: 'team get' })
    expect(env).toMatchSnapshot('get-success-uuid')
  })
})

describe('teamGetRuntime -- team key input', () => {
  it('Test 6: team key (e.g. ENG) -> client.teams({ filter: { key: { eq: "ENG" } }, first: 1 })', async () => {
    const handle = makeMockClient({
      teams: async (_args) => ({ nodes: [TEAM_FIXTURE] }),
    })

    await teamGetRuntime({
      args: { ref: 'eng' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamFn).not.toHaveBeenCalled()
    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.teamsFn.mock.calls[0]?.[0]).toEqual({
      filter: { key: { eq: 'ENG' } },
      first: 1,
    })
  })
})

describe('teamGetRuntime -- name fallthrough', () => {
  it('Test 7: name fallthrough -> client.teams({ filter: { name: { eq: "Engineering" } }, first: 1 })', async () => {
    const handle = makeMockClient({
      teams: async (_args) => ({ nodes: [TEAM_FIXTURE] }),
    })

    await teamGetRuntime({
      args: { ref: 'Engineering' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamFn).not.toHaveBeenCalled()
    expect(handle.teamsFn.mock.calls[0]?.[0]).toEqual({
      filter: { name: { eq: 'Engineering' } },
      first: 1,
    })
  })
})

describe('teamGetRuntime -- not found', () => {
  it('Test 8: empty filter result -> TEAM_NOT_FOUND with details.ref', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await teamGetRuntime({
        args: { ref: 'Engineering' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('TEAM_NOT_FOUND')
      expect(err.details).toMatchObject({ ref: 'Engineering' })
      expect(failure(err, { command: 'team get' })).toMatchSnapshot('failure-TEAM_NOT_FOUND')
    }
  })

  it('Test 9: UUID returns null -> TEAM_NOT_FOUND', async () => {
    const handle = makeMockClient({
      team: async () => null,
    })

    expect.assertions(2)
    try {
      await teamGetRuntime({
        args: { ref: TEAM_UUID },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('TEAM_NOT_FOUND')
    }
  })
})

describe('teamGetRuntime -- single-entity meta', () => {
  it('Test 10: returns single team (not array); meta has NO pageInfo', async () => {
    const handle = makeMockClient({
      team: async () => TEAM_FIXTURE,
    })

    const out = await teamGetRuntime({
      args: { ref: TEAM_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(Array.isArray(out.data)).toBe(false)
    expect(out.meta).not.toHaveProperty('pageInfo')
  })
})

describe('TeamGet oclif command', () => {
  it('Test 10a: enableJsonFlag = true and declares ref arg + workspace + fields flags', () => {
    expect(TeamGet.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(TeamGet.flags)
    for (const expected of ['pretty', 'workspace', 'fields']) {
      expect(flagNames).toContain(expected)
    }
    const argNames = Object.keys(TeamGet.args ?? {})
    expect(argNames).toContain('ref')
  })

  it('Test 10b: runTeamGet is exported as a named function', () => {
    expect(typeof runTeamGet).toBe('function')
  })
})
