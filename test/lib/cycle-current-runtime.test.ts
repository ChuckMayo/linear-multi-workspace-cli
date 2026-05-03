/**
 * `cycleCurrentRuntime` tests (Phase 2 PLAN 02-08 Task 1, CYC-01.current).
 *
 * Coverage:
 *   7. --team ENG -> resolveTeamId -> client.team(uuid) -> team.cycles({ filter: { isActive: { eq: true } }, first: 1 }) -> projected single cycle.
 *   8. --team absent -> WORKFLOW_TEAM_REQUIRED exit 2 BEFORE any SDK call.
 *   9. team.cycles returns 0 nodes -> CYCLE_NOT_FOUND with details.teamId + details.requested.
 *   10. Unknown team -> TEAM_NOT_FOUND.
 *   11. data is single object, NOT array.
 *   12. meta has no pageInfo.
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

import CycleCurrent, { runCycleCurrent } from '@/commands/cycle/current.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { _clearTeamCache } from '@/core/resolvers/index.js'
import { cycleCurrentRuntime } from '@/lib/cycle-current-runtime.js'

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

const CYCLE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TEAM_UUID = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa'

interface CycleConn {
  nodes: Array<Record<string, unknown>>
}

interface MockHandle {
  client: LinearClient
  teamFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  teamCyclesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  team?: (id: string) => Promise<{ cycles: (args: unknown) => Promise<CycleConn> }>
  teams?: () => Promise<{ nodes: Array<{ id: string; key: string; name: string }> }>
  teamCycles?: (args: unknown) => Promise<CycleConn>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const teamCyclesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'team.cycles', args: [args] })
    if (!opts.teamCycles) throw new Error('mock team.cycles not configured')
    return opts.teamCycles(args)
  })
  const teamFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'team', args: [id] })
    if (opts.team) return opts.team(id)
    return { cycles: teamCyclesFn }
  })
  const teamsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams()
  })
  const client = {
    team: teamFn,
    teams: teamsFn,
  } as unknown as LinearClient
  return { client, teamFn, teamsFn, teamCyclesFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'cycle current' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearTeamCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

function fakeActiveCycle(): Record<string, unknown> {
  return {
    id: CYCLE_UUID,
    number: 7,
    name: 'Sprint 7',
    startsAt: '2026-04-01T00:00:00Z',
    endsAt: '2026-04-14T00:00:00Z',
    progress: 0.4,
    isActive: true,
    team: Promise.resolve({ key: 'ENG', name: 'Engineering', id: TEAM_UUID }),
  }
}

describe('cycleCurrentRuntime -- happy path', () => {
  it('Test 7: --team ENG -> resolveTeamId -> client.team -> team.cycles({ filter: { isActive: { eq: true } }, first: 1 }) -> single cycle projection', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      teamCycles: async () => ({ nodes: [fakeActiveCycle()] }),
    })

    const out = await cycleCurrentRuntime({
      flags: { workspace: 'acme', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.teamFn).toHaveBeenCalledTimes(1)
    expect(handle.teamFn.mock.calls[0]?.[0]).toBe(TEAM_UUID)
    expect(handle.teamCyclesFn).toHaveBeenCalledTimes(1)
    const cyclesArgs = handle.teamCyclesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(cyclesArgs.filter).toEqual({ isActive: { eq: true } })
    expect(cyclesArgs.first).toBe(1)

    // data is a single object, NOT an array.
    expect(Array.isArray(out.data)).toBe(false)
    expect((out.data as Record<string, unknown>).id).toBe(CYCLE_UUID)
    expect((out.data as Record<string, unknown>).number).toBe(7)

    const env = success(out.data, { ...out.meta, command: 'cycle current' })
    expect(env).toMatchSnapshot('current-success')
  })
})

describe('cycleCurrentRuntime -- WORKFLOW_TEAM_REQUIRED', () => {
  it('Test 8: --team absent -> WORKFLOW_TEAM_REQUIRED exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await cycleCurrentRuntime({
        flags: { workspace: 'acme' }, // no team
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKFLOW_TEAM_REQUIRED')
      // Factory may be invoked (harmless -- it just constructs the client) but
      // no SDK methods should have fired.
      expect(handle.callLog).toHaveLength(0)
      expect(handle.teamsFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WORKFLOW_TEAM_REQUIRED')
    }
  })
})

describe('cycleCurrentRuntime -- no active cycle', () => {
  it('Test 9: team.cycles returns 0 nodes -> CYCLE_NOT_FOUND with teamId + requested:current', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      teamCycles: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await cycleCurrentRuntime({
        flags: { workspace: 'acme', team: 'ENG' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('CYCLE_NOT_FOUND')
      expect(err.message).toMatch(/no active cycle/)
      expect(err.details).toMatchObject({ teamId: TEAM_UUID, requested: 'current' })
    }
  })
})

describe('cycleCurrentRuntime -- TEAM_NOT_FOUND', () => {
  it('Test 10: unknown team -> TEAM_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
    })

    expect.assertions(3)
    try {
      await cycleCurrentRuntime({
        flags: { workspace: 'acme', team: 'BOGUS' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('TEAM_NOT_FOUND')
      expect(handle.teamFn).not.toHaveBeenCalled()
    }
  })
})

describe('cycleCurrentRuntime -- meta shape', () => {
  it('Test 11: data is single projected cycle (NOT array)', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      teamCycles: async () => ({ nodes: [fakeActiveCycle()] }),
    })

    const out = await cycleCurrentRuntime({
      flags: { workspace: 'acme', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(Array.isArray(out.data)).toBe(false)
    expect(typeof out.data).toBe('object')
    expect((out.data as Record<string, unknown>).id).toBe(CYCLE_UUID)
  })

  it('Test 12: meta has NO pageInfo (single entity)', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      teamCycles: async () => ({ nodes: [fakeActiveCycle()] }),
    })

    const out = await cycleCurrentRuntime({
      flags: { workspace: 'acme', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect((out.meta as Record<string, unknown>).pageInfo).toBeUndefined()
    expect(out.meta.workspace).toBe('acme')
  })
})

describe('CycleCurrent oclif command', () => {
  it('Test current-cmd-a: enableJsonFlag = true and declares workspace, fields, team', () => {
    expect(CycleCurrent.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CycleCurrent.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'team']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test current-cmd-b: runCycleCurrent is exported as a named function', () => {
    expect(typeof runCycleCurrent).toBe('function')
  })
})
