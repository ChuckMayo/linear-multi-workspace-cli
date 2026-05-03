/**
 * `cycleMoveRuntime` tests (Phase 2 PLAN 02-08 Task 2, CYC-01.move).
 *
 * Coverage:
 *   1. ENG-1 + --to next -> resolveIssue (issues filter) + resolveCycleId('next') + updateIssue(uuid, { cycleId }).
 *   2. --to <UUID> -> resolveCycleId passthrough.
 *   3. --to current -> active cycle UUID via resolveCycleId.
 *   4. --to +1/-1/0/next/previous -> all valid (delegated to resolveCycleId).
 *   5. WSP-06 -- no explicit workspace -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call.
 *   6. Issue ref UUID -> client.issue(uuid) (still need teamId from issue).
 *   7. ISSUE_NOT_FOUND when issue ref doesn't resolve.
 *   8. CYCLE_NOT_FOUND when cycle ref doesn't resolve.
 *   9. payload.success === false -> LINEAR_API_ERROR.
 *   10. Returns updated issue projected per fields.
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

import CycleMove, { runCycleMove } from '@/commands/cycle/move.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { _clearCycleCache, _clearTeamCache } from '@/core/resolvers/index.js'
import { cycleMoveRuntime } from '@/lib/cycle-move-runtime.js'

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

const ISSUE_UUID = '11111111-2222-3333-4444-555555555555'
const TEAM_UUID = '66666666-7777-8888-9999-aaaaaaaaaaaa'
const CYCLE_CURRENT_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const CYCLE_NEXT_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const CYCLE_PREV_UUID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

interface UpdatePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  issuesFn: ReturnType<typeof vi.fn>
  issueFn: ReturnType<typeof vi.fn>
  updateIssueFn: ReturnType<typeof vi.fn>
  teamFn: ReturnType<typeof vi.fn>
  teamCyclesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issues?: (args: unknown) => Promise<{ nodes: Array<Record<string, unknown>> }>
  issue?: (id: string) => Promise<Record<string, unknown> | null | undefined>
  updateIssue?: (id: string, input: Record<string, unknown>) => Promise<UpdatePayload>
  team?: (id: string) => Promise<{ cycles: (args: unknown) => Promise<unknown> }>
  teamCycles?: (args: unknown) => Promise<{
    nodes: Array<{ id: string; number: number; name: string | null; isActive: boolean }>
  }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const issuesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'issues', args: [args] })
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const issueFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'issue', args: [id] })
    if (!opts.issue) throw new Error('mock client.issue not configured')
    return opts.issue(id)
  })
  const updateIssueFn = vi.fn(async (id: string, input: Record<string, unknown>) => {
    callLog.push({ method: 'updateIssue', args: [id, input] })
    if (!opts.updateIssue) throw new Error('mock client.updateIssue not configured')
    return opts.updateIssue(id, input)
  })
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
  const client = {
    issues: issuesFn,
    issue: issueFn,
    updateIssue: updateIssueFn,
    team: teamFn,
  } as unknown as LinearClient
  return { client, issuesFn, issueFn, updateIssueFn, teamFn, teamCyclesFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'cycle move' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearCycleCache()
  _clearTeamCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

function fakeIssue(id: string, teamId: string): Record<string, unknown> {
  return {
    id,
    identifier: 'ENG-1',
    title: 'Test issue',
    team: Promise.resolve({ id: teamId, key: 'ENG' }),
  }
}

function fakeUpdatedIssue(id: string): Record<string, unknown> {
  return {
    id,
    identifier: 'ENG-1',
    title: 'Test issue',
    state: Promise.resolve({ name: 'In Progress' }),
    priority: 0,
    assignee: Promise.resolve({ email: 'a@example.com' }),
    team: Promise.resolve({ key: 'ENG' }),
    updatedAt: '2026-04-02T00:00:00Z',
  }
}

const ACTIVE_CYCLE_LIST = [
  { id: CYCLE_PREV_UUID, number: 6, name: 'Sprint 6', isActive: false },
  { id: CYCLE_CURRENT_UUID, number: 7, name: 'Sprint 7', isActive: true },
  { id: CYCLE_NEXT_UUID, number: 8, name: 'Sprint 8', isActive: false },
]

describe('cycleMoveRuntime -- happy path', () => {
  it('Test 1: ENG-1 + --to next -> resolveIssue (filter) + resolveCycleId(next) + updateIssue', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await cycleMoveRuntime({
      args: { issue: 'ENG-1', to: 'next' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).toHaveBeenCalledTimes(1)
    expect(handle.teamFn).toHaveBeenCalledTimes(1)
    expect(handle.teamCyclesFn).toHaveBeenCalledTimes(1)
    expect(handle.updateIssueFn).toHaveBeenCalledTimes(1)
    // EXACT call shape: client.updateIssue(issueId, { cycleId })
    expect(handle.updateIssueFn.mock.calls[0]?.[0]).toBe(ISSUE_UUID)
    expect(handle.updateIssueFn.mock.calls[0]?.[1]).toEqual({ cycleId: CYCLE_NEXT_UUID })

    const env = success(out.data, { ...out.meta, command: 'cycle move' })
    expect(env).toMatchSnapshot('move-success')
  })
})

describe('cycleMoveRuntime -- direct UUID cycle ref', () => {
  it('Test 2: --to <UUID> -> resolveCycleId passthrough; updateIssue called with that UUID', async () => {
    const directUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await cycleMoveRuntime({
      args: { issue: 'ENG-1', to: directUuid },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // No team.cycles fetch (UUID short-circuited resolveCycleId).
    expect(handle.teamCyclesFn).not.toHaveBeenCalled()
    expect(handle.updateIssueFn.mock.calls[0]?.[0]).toBe(ISSUE_UUID)
    expect(handle.updateIssueFn.mock.calls[0]?.[1]).toEqual({ cycleId: directUuid })
  })
})

describe('cycleMoveRuntime -- --to current', () => {
  it('Test 3: --to current -> active cycle UUID via resolveCycleId', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await cycleMoveRuntime({
      args: { issue: 'ENG-1', to: 'current' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateIssueFn.mock.calls[0]?.[1]).toEqual({ cycleId: CYCLE_CURRENT_UUID })
  })
})

describe('cycleMoveRuntime -- --to +1/-1/0/next/previous', () => {
  it.each([
    ['+1', CYCLE_NEXT_UUID],
    ['-1', CYCLE_PREV_UUID],
    ['0', CYCLE_CURRENT_UUID],
    ['next', CYCLE_NEXT_UUID],
    ['previous', CYCLE_PREV_UUID],
  ])('Test 4: --to %s -> resolves to %s', async (ref, expected) => {
    _clearCycleCache()
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await cycleMoveRuntime({
      args: { issue: 'ENG-1', to: ref },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateIssueFn.mock.calls[0]?.[1]).toEqual({ cycleId: expected })
  })
})

describe('cycleMoveRuntime -- WSP-06', () => {
  it('Test 5: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await cycleMoveRuntime({
        args: { issue: 'ENG-1', to: 'next' },
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WSP-06-write-guard')
    }
  })
})

describe('cycleMoveRuntime -- issue ref UUID', () => {
  it('Test 6: <issue-uuid> -> client.issue(uuid) (still needs teamId for resolveCycleId)', async () => {
    const handle = makeMockClient({
      issue: async () => fakeIssue(ISSUE_UUID, TEAM_UUID),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await cycleMoveRuntime({
      args: { issue: ISSUE_UUID, to: 'next' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).not.toHaveBeenCalled()
    expect(handle.issueFn).toHaveBeenCalledTimes(1)
    expect(handle.issueFn.mock.calls[0]?.[0]).toBe(ISSUE_UUID)
    expect(handle.updateIssueFn.mock.calls[0]?.[0]).toBe(ISSUE_UUID)
    expect(handle.updateIssueFn.mock.calls[0]?.[1]).toEqual({ cycleId: CYCLE_NEXT_UUID })
  })
})

describe('cycleMoveRuntime -- ISSUE_NOT_FOUND', () => {
  it('Test 7: ENG-99 with no matching issue -> ISSUE_NOT_FOUND', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [] }),
    })

    expect.assertions(3)
    try {
      await cycleMoveRuntime({
        args: { issue: 'ENG-99', to: 'next' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(handle.updateIssueFn).not.toHaveBeenCalled()
    }
  })
})

describe('cycleMoveRuntime -- CYCLE_NOT_FOUND', () => {
  it('Test 8: --to +99 with team only having 3 cycles -> CYCLE_NOT_FOUND', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
    })

    expect.assertions(3)
    try {
      await cycleMoveRuntime({
        args: { issue: 'ENG-1', to: '+99' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('CYCLE_NOT_FOUND')
      expect(handle.updateIssueFn).not.toHaveBeenCalled()
    }
  })
})

describe('cycleMoveRuntime -- payload failure', () => {
  it('Test 9: payload.success === false -> LINEAR_API_ERROR', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await cycleMoveRuntime({
        args: { issue: 'ENG-1', to: 'next' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(err.details).toMatchObject({ lastSyncId: 42 })
    }
  })
})

describe('cycleMoveRuntime -- projection', () => {
  it('Test 10: returns updated issue projected per --fields=ids', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      teamCycles: async () => ({ nodes: ACTIVE_CYCLE_LIST }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await cycleMoveRuntime({
      args: { issue: 'ENG-1', to: 'next' },
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // ids preset for issue is just ['id', 'identifier'].
    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1' })
  })
})

describe('CycleMove oclif command', () => {
  it('Test move-cmd-a: enableJsonFlag = true; declares write-guard flags + issue arg + --to flag', () => {
    expect(CycleMove.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CycleMove.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'to',
    ]) {
      expect(flagNames).toContain(expected)
    }
    const argNames = Object.keys(CycleMove.args)
    expect(argNames).toContain('issue')
  })

  it('Test move-cmd-b: runCycleMove is exported as a named function', () => {
    expect(typeof runCycleMove).toBe('function')
  })
})
