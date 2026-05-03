/**
 * `stateListRuntime` tests (Phase 2 PLAN 02-09 Task 1, STA-01).
 *
 * Coverage:
 *   1. No filter -> client.workflowStates({ first: 25 }) returns ALL states.
 *   2. --team ENG -> filter: { team: { key: { eq: 'ENG' } } } (no team-resolver round-trip).
 *   3. --team <uuid> -> filter: { team: { id: { eq: <uuid> } } }.
 *   4. --team Engineering -> filter: { team: { name: { eq: 'Engineering' } } }.
 *   5. Pagination -- --limit 50 --cursor x -> { first: 50, after: 'x' }.
 *   6. Default projection per FIELD_PRESETS.state (lazy hydration of team).
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

import StateList, { runStateList } from '@/commands/state/list.js'
import type { Config } from '@/core/config/index.js'
import { success } from '@/core/output/index.js'
import { stateListRuntime } from '@/lib/state-list-runtime.js'

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
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface MockHandle {
  client: LinearClient
  workflowStatesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  workflowStates?: (args: Record<string, unknown>) => Promise<SdkConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const workflowStatesFn = vi.fn(async (args: Record<string, unknown>) => {
    callLog.push({ method: 'workflowStates', args: [args] })
    if (!opts.workflowStates) throw new Error('mock client.workflowStates not configured')
    return opts.workflowStates(args)
  })
  const client = { workflowStates: workflowStatesFn } as unknown as LinearClient
  return { client, workflowStatesFn, callLog }
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

function makeStateNode(): Record<string, unknown> {
  return {
    id: 'state-uuid-1',
    name: 'Todo',
    type: 'unstarted',
    color: '#aaa',
    position: 1,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    team: Promise.resolve({ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }),
  }
}

describe('stateListRuntime -- no filter', () => {
  it('Test 11: no --team -> client.workflowStates({ first: 25 }) (no filter)', async () => {
    const handle = makeMockClient({
      workflowStates: async (_args) => ({
        nodes: [makeStateNode()],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await stateListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn).toHaveBeenCalledTimes(1)
    expect(handle.workflowStatesFn.mock.calls[0]?.[0]).toEqual({ first: 25 })
    const env = success(out.data, { ...out.meta, command: 'state list' })
    expect(env).toMatchSnapshot('list-success-no-filter')
  })
})

describe('stateListRuntime -- team filter inline routing', () => {
  it('Test 12a: --team ENG -> filter: { team: { key: { eq: "ENG" } } } (no SDK round-trip)', async () => {
    const handle = makeMockClient({
      workflowStates: async (_args) => ({ nodes: [], pageInfo: undefined }),
    })

    await stateListRuntime({
      flags: { workspace: 'acme', team: 'eng' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const args = handle.workflowStatesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args).toMatchObject({
      first: 25,
      filter: { team: { key: { eq: 'ENG' } } },
    })
  })

  it('Test 12b: --team <uuid> -> filter: { team: { id: { eq: <uuid> } } }', async () => {
    const handle = makeMockClient({
      workflowStates: async () => ({ nodes: [] }),
    })

    await stateListRuntime({
      flags: { workspace: 'acme', team: TEAM_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn.mock.calls[0]?.[0]).toMatchObject({
      filter: { team: { id: { eq: TEAM_UUID } } },
    })
  })

  it('Test 12c: --team Engineering -> filter: { team: { name: { eq: "Engineering" } } }', async () => {
    const handle = makeMockClient({
      workflowStates: async () => ({ nodes: [] }),
    })

    await stateListRuntime({
      flags: { workspace: 'acme', team: 'Engineering' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn.mock.calls[0]?.[0]).toMatchObject({
      filter: { team: { name: { eq: 'Engineering' } } },
    })
  })
})

describe('stateListRuntime -- pagination', () => {
  it('Test 13: --limit 50 --cursor x -> { first: 50, after: "x" }', async () => {
    const handle = makeMockClient({
      workflowStates: async () => ({ nodes: [] }),
    })

    await stateListRuntime({
      flags: { workspace: 'acme', limit: 50, cursor: 'x' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn.mock.calls[0]?.[0]).toEqual({ first: 50, after: 'x' })
  })
})

describe('stateListRuntime -- projection (lazy hydration of team)', () => {
  it('Test 14: defaults preset awaits state.team to project team.key', async () => {
    const handle = makeMockClient({
      workflowStates: async () => ({
        nodes: [makeStateNode()],
        pageInfo: undefined,
      }),
    })

    const out = await stateListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const projected = (out.data as Array<Record<string, unknown>>)[0]
    expect(projected).toBeDefined()
    expect(((projected as Record<string, unknown>).team as Record<string, unknown>).key).toBe('ENG')
  })
})

describe('StateList oclif command', () => {
  it('Test 14a: enableJsonFlag = true and declares pagination + workspace + fields + team flags', () => {
    expect(StateList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(StateList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor', 'team']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 14b: runStateList is exported as a named function', () => {
    expect(typeof runStateList).toBe('function')
  })
})
