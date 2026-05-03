/**
 * `teamListRuntime` tests (Phase 2 PLAN 02-09 Task 1, TEM-01.list).
 *
 * Coverage:
 *   1. Default pagination -- client.teams({ first: 25 }), projects per defaults preset.
 *   2. Pagination -- --limit 10 --cursor token -> { first: 10, after: 'token' }.
 *   3. meta.pageInfo populated; empty list returns data: [].
 *   4. --fields=ids returns { id, key } per team (TEAM_PRESETS.ids).
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

import TeamList, { runTeamList } from '@/commands/team/list.js'
import type { Config } from '@/core/config/index.js'
import { success } from '@/core/output/index.js'
import { teamListRuntime } from '@/lib/team-list-runtime.js'

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

interface SdkConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface MockHandle {
  client: LinearClient
  teamsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  teams?: (args: Record<string, unknown>) => Promise<SdkConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const teamsFn = vi.fn(async (args: Record<string, unknown>) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams(args)
  })
  const client = { teams: teamsFn } as unknown as LinearClient
  return { client, teamsFn, callLog }
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

const TEAM_A: Record<string, unknown> = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  key: 'ENG',
  name: 'Engineering',
  description: 'eng team',
  color: '#000',
  private: false,
  createdAt: '2026-01-01T00:00:00Z',
  cycleEnabled: true,
}

const TEAM_B: Record<string, unknown> = {
  id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  key: 'DSGN',
  name: 'Design',
  description: null,
  color: '#fff',
  private: true,
  createdAt: '2026-01-02T00:00:00Z',
  cycleEnabled: false,
}

describe('teamListRuntime -- default pagination', () => {
  it('Test 1: default pagination -> client.teams({ first: 25 }) and projects per defaults preset', async () => {
    const handle = makeMockClient({
      teams: async (_args) => ({
        nodes: [TEAM_A, TEAM_B],
        pageInfo: {
          hasNextPage: false,
          endCursor: 'cursor-end',
          hasPreviousPage: false,
          startCursor: 'cursor-start',
        },
      }),
    })

    const out = await teamListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.teamsFn.mock.calls[0]?.[0]).toEqual({ first: 25 })
    expect(Array.isArray(out.data)).toBe(true)
    expect((out.data as unknown[]).length).toBe(2)
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')

    const env = success(out.data, { ...out.meta, command: 'team list' })
    expect(env).toMatchSnapshot('list-success-defaults')
  })
})

describe('teamListRuntime -- pagination', () => {
  it('Test 2: --limit 10 --cursor token -> { first: 10, after: "token" }', async () => {
    const handle = makeMockClient({
      teams: async (_args) => ({
        nodes: [],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    await teamListRuntime({
      flags: { workspace: 'acme', limit: 10, cursor: 'token' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn.mock.calls[0]?.[0]).toEqual({ first: 10, after: 'token' })
  })
})

describe('teamListRuntime -- empty list', () => {
  it('Test 3: empty connection returns data: [] with pageInfo populated', async () => {
    const handle = makeMockClient({
      teams: async () => ({
        nodes: [],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await teamListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
    expect(out.meta.pageInfo).toBeDefined()
  })
})

describe('teamListRuntime -- --fields=ids', () => {
  it('Test 4: --fields=ids returns { id, key } per team', async () => {
    const handle = makeMockClient({
      teams: async () => ({
        nodes: [TEAM_A, TEAM_B],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await teamListRuntime({
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([
      { id: TEAM_A.id, key: TEAM_A.key },
      { id: TEAM_B.id, key: TEAM_B.key },
    ])
  })
})

describe('TeamList oclif command', () => {
  it('Test 4b: enableJsonFlag = true and declares pagination + workspace + fields flags', () => {
    expect(TeamList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(TeamList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 4c: runTeamList is exported as a named function', () => {
    expect(typeof runTeamList).toBe('function')
  })
})
