/**
 * `cycleListRuntime` tests (Phase 2 PLAN 02-08 Task 1, CYC-01.list).
 *
 * Coverage:
 *   1. Workspace-wide list -- client.cycles({ first: 25 }), default preset
 *      lazy-hydrates team.
 *   2. --team ENG -> resolveTeamId then client.cycles({ filter: { team: { id: { eq: <uuid> } } } }).
 *   3. --team <UUID> passthrough -> same call shape.
 *   4. Pagination -- --limit 10 --cursor token.
 *   5. Empty result -> data: [].
 *   6. Lazy hydration -- defaults preset awaits team (default preset includes team.key).
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
      client: { rawRequest: (q: string, vars: unknown) => Promise<unknown> }
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
        this.client = {
          rawRequest: async (q: string, vars: unknown): Promise<unknown> => {
            if (!mockRawRequestFn) throw new Error('mockRawRequestFn not configured')
            return mockRawRequestFn(q, vars)
          },
        }
      }
    },
  }
})

import type { LinearClient } from '@linear/sdk'

import CycleList, { runCycleList } from '@/commands/cycle/list.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { success } from '@/core/output/index.js'
import { _clearTeamCache } from '@/core/resolvers/index.js'
import { cycleListRuntime } from '@/lib/cycle-list-runtime.js'

// Module-level rawRequest mock for --include tests (Phase 3 RAW-04)
let mockRawRequestFn: ((q: string, vars: unknown) => Promise<unknown>) | null = null
let rawRequestCallCount = 0

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

const CYCLE_UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CYCLE_UUID_2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const TEAM_UUID = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa'

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
  cyclesFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  cycles?: (args: unknown) => Promise<SdkConnection>
  teams?: () => Promise<{ nodes: Array<{ id: string; key: string; name: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const cyclesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'cycles', args: [args] })
    if (!opts.cycles) throw new Error('mock client.cycles not configured')
    return opts.cycles(args)
  })
  const teamsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams()
  })
  const rawRequest = async (q: string, vars: unknown): Promise<unknown> => {
    if (!mockRawRequestFn) throw new Error('mockRawRequestFn not configured')
    rawRequestCallCount++
    return mockRawRequestFn(q, vars)
  }
  const client = {
    cycles: cyclesFn,
    teams: teamsFn,
    client: { rawRequest },
  } as unknown as LinearClient
  return { client, cyclesFn, teamsFn, callLog }
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearTeamCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
  mockRawRequestFn = null
  rawRequestCallCount = 0
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
  mockRawRequestFn = null
  rawRequestCallCount = 0
})

function fakeCycle(id: string, num = 1): Record<string, unknown> {
  return {
    id,
    number: num,
    name: `Cycle ${num}`,
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2026-01-14T00:00:00Z',
    progress: 0.5,
    isActive: false,
    team: Promise.resolve({ key: 'ENG', name: 'Engineering', id: TEAM_UUID }),
  }
}

describe('cycleListRuntime -- workspace-wide (no --team)', () => {
  it('Test 1: client.cycles({ first: 25 }) with no filter; team is hydrated for default preset', async () => {
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [fakeCycle(CYCLE_UUID_1, 1)],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await cycleListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.cyclesFn).toHaveBeenCalledTimes(1)
    expect(handle.teamsFn).not.toHaveBeenCalled()
    const args = handle.cyclesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(25)
    expect(args.after).toBeUndefined()
    expect(args.filter).toBeUndefined()
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(Array.isArray(out.data)).toBe(true)
    expect((out.data as unknown[]).length).toBe(1)

    const env = success(out.data, { ...out.meta, command: 'cycle list' })
    expect(env).toMatchSnapshot('list-success-workspace-wide')
  })
})

describe('cycleListRuntime -- --team ENG filter', () => {
  it('Test 2: --team ENG -> resolveTeamId then cycles({ filter: { team: { id: { eq: uuid } } } })', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      cycles: async () => ({
        nodes: [fakeCycle(CYCLE_UUID_1, 1)],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await cycleListRuntime({
      flags: { workspace: 'acme', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.cyclesFn).toHaveBeenCalledTimes(1)
    const args = handle.cyclesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(25)
    expect(args.filter).toEqual({ team: { id: { eq: TEAM_UUID } } })
  })
})

describe('cycleListRuntime -- --team <UUID> passthrough', () => {
  it('Test 3: --team <UUID> passes through resolveTeamId; same filter shape', async () => {
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await cycleListRuntime({
      flags: { workspace: 'acme', team: TEAM_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // No teams() lookup needed -- UUID short-circuits.
    expect(handle.teamsFn).not.toHaveBeenCalled()
    expect(handle.cyclesFn).toHaveBeenCalledTimes(1)
    const args = handle.cyclesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.filter).toEqual({ team: { id: { eq: TEAM_UUID } } })
  })
})

describe('cycleListRuntime -- pagination', () => {
  it('Test 4: --limit 10 --cursor token -> { first: 10, after: "token" }', async () => {
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await cycleListRuntime({
      flags: { workspace: 'acme', limit: 10, cursor: 'opaque-token-abc' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const args = handle.cyclesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(10)
    expect(args.after).toBe('opaque-token-abc')
  })
})

describe('cycleListRuntime -- empty result', () => {
  it('Test 5: empty connection -> data: []', async () => {
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await cycleListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
  })
})

describe('cycleListRuntime -- lazy hydration on defaults preset', () => {
  it('Test 6: --fields=defaults awaits team on each node; default preset includes team.key', async () => {
    const teamGetSpy = vi.fn(() => Promise.resolve({ key: 'ENG', name: 'Engineering' }))
    const node: Record<string, unknown> = Object.defineProperties(
      {
        id: CYCLE_UUID_2,
        number: 2,
        name: 'Cycle 2',
        startsAt: '2026-01-15T00:00:00Z',
        endsAt: '2026-01-28T00:00:00Z',
        progress: 0,
        isActive: false,
      },
      {
        team: { enumerable: true, configurable: true, get: teamGetSpy },
      },
    )
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [node],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await cycleListRuntime({
      flags: { workspace: 'acme', fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // defaults preset references `team.key` -- runtime touched the team getter.
    expect(teamGetSpy).toHaveBeenCalled()
    const projected = (out.data as Array<Record<string, unknown>>)[0]
    expect(projected).toBeDefined()
    expect((projected as Record<string, unknown>).id).toBe(CYCLE_UUID_2)
    expect((projected as Record<string, Record<string, unknown>>).team?.key).toBe('ENG')
  })
})

describe('CycleList oclif command', () => {
  it('Test list-cmd-a: enableJsonFlag = true and declares workspace, fields, limit, cursor, team', () => {
    expect(CycleList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CycleList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor', 'team']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test list-cmd-b: runCycleList is exported as a named function', () => {
    expect(typeof runCycleList).toBe('function')
  })

  it('Test list-cmd-c: --include flag declared on CycleList command', () => {
    const flagNames = Object.keys(CycleList.flags)
    expect(flagNames).toContain('include')
  })
})

// -----------------------------------------------------------------------------
// Phase 3 --include tests (RAW-04)
// -----------------------------------------------------------------------------

describe('cycleListRuntime -- --include (Phase 3 RAW-04)', () => {
  it('Test 6e: empty --include preserves Phase 2 behavior (typed SDK cycles() called; rawRequest NOT called)', async () => {
    const handle = makeMockClient({
      cycles: async () => ({
        nodes: [fakeCycle(CYCLE_UUID_1, 1)],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await cycleListRuntime({
      flags: { workspace: 'acme', include: [] },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // Phase 2 typed path used
    expect(handle.cyclesFn).toHaveBeenCalledTimes(1)
    expect(rawRequestCallCount).toBe(0)
    expect(out.data).toBeInstanceOf(Array)
  })

  it('Test 7e: flags.include=["issues"] -> rawRequest called ONCE; cycles() NOT called', async () => {
    mockRawRequestFn = async () => ({
      data: {
        cycles: {
          nodes: [
            {
              id: CYCLE_UUID_1,
              number: 1,
              name: 'Cycle 1',
              startsAt: '2026-01-01T00:00:00Z',
              endsAt: '2026-01-14T00:00:00Z',
              issues: { nodes: [{ id: 'iss-1', identifier: 'ENG-1', title: 'first' }] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })

    const handle = makeMockClient({})

    const out = await cycleListRuntime({
      flags: { workspace: 'acme', include: ['issues'] },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // rawRequest called exactly once
    expect(rawRequestCallCount).toBe(1)
    // Typed cycles() NOT called
    expect(handle.cyclesFn).not.toHaveBeenCalled()
    expect(out.data).toBeInstanceOf(Array)
    expect(out).toMatchSnapshot('include-issues-success')
  })

  it('Test 8e: flags.include=["nonexistentKey"] -> INVALID_INCLUDE (exit 2); rawRequest NOT called', async () => {
    const handle = makeMockClient({})

    expect.assertions(4)
    try {
      await cycleListRuntime({
        flags: { workspace: 'acme', include: ['nonexistentKey'] },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('INVALID_INCLUDE')
      expect(rawRequestCallCount).toBe(0)
      expect(handle.cyclesFn).not.toHaveBeenCalled()
    }
  })

  // Regression: REVIEW BL-02 — `cycle list --team X --include Y` must
  // thread `--team` through to the rawRequest path. Before the fix, the
  // --include branch composed `cycles(first, after)` with no `filter`
  // argument and silently returned cycles from EVERY team.
  it('Test 9e (BL-02): --team ENG + --include issues threads filter on rawRequest path', async () => {
    let capturedQuery = ''
    let capturedVars: unknown
    mockRawRequestFn = async (q, vars) => {
      capturedQuery = q
      capturedVars = vars
      return {
        data: {
          cycles: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    }

    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
    })

    await cycleListRuntime({
      flags: { workspace: 'acme', team: 'ENG', include: ['issues'] },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // teams() lookup happened to resolve ENG -> UUID
    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    // rawRequest path used (not typed cycles())
    expect(rawRequestCallCount).toBe(1)
    expect(handle.cyclesFn).not.toHaveBeenCalled()
    // Composed query declares the $filter variable AND passes it to cycles()
    expect(capturedQuery).toContain('$filter: CycleFilter')
    expect(capturedQuery).toContain('cycles(filter: $filter')
    // Filter actually shipped to Linear with the resolved UUID
    expect(capturedVars).toMatchObject({
      filter: { team: { id: { eq: TEAM_UUID } } },
    })
  })

  it('Test 10e (BL-02): --team <uuid> + --include skips teams() lookup but still threads filter', async () => {
    let capturedVars: unknown
    mockRawRequestFn = async (_q, vars) => {
      capturedVars = vars
      return {
        data: {
          cycles: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    }

    const handle = makeMockClient({})

    await cycleListRuntime({
      flags: { workspace: 'acme', team: TEAM_UUID, include: ['issues'] },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // UUID passthrough: no teams() lookup
    expect(handle.teamsFn).not.toHaveBeenCalled()
    expect(rawRequestCallCount).toBe(1)
    expect(capturedVars).toMatchObject({
      filter: { team: { id: { eq: TEAM_UUID } } },
    })
  })
})
