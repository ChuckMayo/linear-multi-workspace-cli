/**
 * `labelCreateRuntime` tests (Phase 2 PLAN 02-09 Task 2, LBL-01.create).
 *
 * Coverage:
 *   1. --name + --team ENG --workspace acme -> resolves team key to UUID via
 *      client.teams filter, then client.createIssueLabel({ name, teamId }).
 *   2. Optional --color and --description included in createInput when supplied.
 *   3. WSP-06 -- no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE
 *      BEFORE any SDK call (factory not invoked).
 *   4. Missing --name -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   5. Missing --team -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   6. Unknown team key -> client.teams returns 0 nodes -> TEAM_NOT_FOUND.
 *   7. payload.success === false -> LINEAR_API_ERROR with details.lastSyncId.
 *   8. UUID --team passes through (no client.teams round-trip).
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

import LabelCreate, { runLabelCreate } from '@/commands/label/create.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { labelCreateRuntime } from '@/lib/label-create-runtime.js'

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
const LABEL_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

interface CreatePayload {
  success: boolean
  lastSyncId: number
  issueLabel?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface SdkTeamConnection {
  nodes: Array<{ id: string }>
}

interface MockHandle {
  client: LinearClient
  createIssueLabelFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  createIssueLabel?: (input: Record<string, unknown>) => Promise<CreatePayload>
  teams?: (args: Record<string, unknown>) => Promise<SdkTeamConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const createIssueLabelFn = vi.fn(async (input: Record<string, unknown>) => {
    callLog.push({ method: 'createIssueLabel', args: [input] })
    if (!opts.createIssueLabel) throw new Error('mock client.createIssueLabel not configured')
    return opts.createIssueLabel(input)
  })
  const teamsFn = vi.fn(async (args: Record<string, unknown>) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams(args)
  })
  const client = {
    createIssueLabel: createIssueLabelFn,
    teams: teamsFn,
  } as unknown as LinearClient
  return { client, createIssueLabelFn, teamsFn, callLog }
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

function fakeCreatedLabel(): Record<string, unknown> {
  return {
    id: LABEL_UUID,
    name: 'p0',
    color: '#ff0000',
    description: 'highest priority',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    team: Promise.resolve({ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }),
    parent: Promise.resolve(undefined),
  }
}

describe('labelCreateRuntime -- happy path (key resolution)', () => {
  it('Test 6: --name p0 --team ENG -> resolves key to UUID then createIssueLabel({ name, teamId })', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID }] }),
      createIssueLabel: async (_input) => ({
        success: true,
        lastSyncId: 100,
        issueLabel: Promise.resolve(fakeCreatedLabel()),
      }),
    })

    const out = await labelCreateRuntime({
      args: {},
      flags: { workspace: 'acme', name: 'p0', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.teamsFn.mock.calls[0]?.[0]).toEqual({
      filter: { key: { eq: 'ENG' } },
      first: 1,
    })
    expect(handle.createIssueLabelFn).toHaveBeenCalledTimes(1)
    const callInput = handle.createIssueLabelFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({ name: 'p0', teamId: TEAM_UUID })

    const env = success(out.data, { ...out.meta, command: 'label create' })
    expect(env).toMatchSnapshot('create-success-key-resolution')
  })
})

describe('labelCreateRuntime -- optional flags', () => {
  it('Test 7: --color and --description included when supplied', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID }] }),
      createIssueLabel: async () => ({
        success: true,
        lastSyncId: 100,
        issueLabel: Promise.resolve(fakeCreatedLabel()),
      }),
    })

    await labelCreateRuntime({
      args: {},
      flags: {
        workspace: 'acme',
        name: 'p0',
        team: 'ENG',
        color: '#ff0000',
        description: 'highest priority',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const callInput = handle.createIssueLabelFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({
      name: 'p0',
      teamId: TEAM_UUID,
      color: '#ff0000',
      description: 'highest priority',
    })
  })
})

describe('labelCreateRuntime -- WSP-06', () => {
  it('Test 8: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await labelCreateRuntime({
        args: {},
        flags: { name: 'p0', team: 'ENG' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      // Factory is built AFTER WSP-06 -- guard runs before client is created.
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
      expect(failure(err, { command: 'label create' })).toMatchSnapshot(
        'failure-WSP-06-write-guard',
      )
    }
  })
})

describe('labelCreateRuntime -- USAGE_ERROR (missing flags)', () => {
  it('Test 9: missing --name -> USAGE_ERROR BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await labelCreateRuntime({
        args: {},
        flags: { workspace: 'acme', team: 'ENG' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--name is required/)
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
    }
  })

  it('Test 10: missing --team -> USAGE_ERROR BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await labelCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'p0' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--team is required/)
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
    }
  })
})

describe('labelCreateRuntime -- TEAM_NOT_FOUND', () => {
  it('Test 11: unknown team -> client.teams returns 0 -> TEAM_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await labelCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'p0', team: 'BOGUS' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('TEAM_NOT_FOUND')
      expect(err.details).toMatchObject({ ref: 'BOGUS' })
      expect(failure(err, { command: 'label create' })).toMatchSnapshot('failure-TEAM_NOT_FOUND')
    }
  })
})

describe('labelCreateRuntime -- payload failure', () => {
  it('Test 12: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID }] }),
      createIssueLabel: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await labelCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'p0', team: 'ENG' },
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

describe('labelCreateRuntime -- UUID team passthrough', () => {
  it('Test 13: --team <uuid> passes through (no client.teams round-trip)', async () => {
    const handle = makeMockClient({
      createIssueLabel: async () => ({
        success: true,
        lastSyncId: 100,
        issueLabel: Promise.resolve(fakeCreatedLabel()),
      }),
    })

    await labelCreateRuntime({
      args: {},
      flags: { workspace: 'acme', name: 'p0', team: TEAM_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).not.toHaveBeenCalled()
    const callInput = handle.createIssueLabelFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({ name: 'p0', teamId: TEAM_UUID })
  })
})

describe('LabelCreate oclif command', () => {
  it('Test 13a: enableJsonFlag = true and declares --name (required), --team (required), --color, --description, write-guard flags', () => {
    expect(LabelCreate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(LabelCreate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'name',
      'team',
      'color',
      'description',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 13b: runLabelCreate is exported as a named function', () => {
    expect(typeof runLabelCreate).toBe('function')
  })
})
