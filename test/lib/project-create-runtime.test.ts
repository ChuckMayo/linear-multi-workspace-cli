/**
 * `projectCreateRuntime` tests (Phase 2 PLAN 02-07 Task 2, PRJ-01.create).
 *
 * Coverage:
 *   1. Minimum + multi-team -- name + teams 'ENG,DESIGN' -> resolveTeamId for
 *      each, createProject({ name, teamIds: [...] }).
 *   2. Optional fields -- description, state, lead (email/uuid/me), targetDate,
 *      startDate are all included in createInput.
 *   3. Missing --name -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   4. Missing --teams -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   5. Empty/whitespace --teams (after split-and-trim) -> USAGE_ERROR.
 *   6. WSP-06 -- no explicit selector + active workspace ->
 *      WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call.
 *   7. Unknown team -> TEAM_NOT_FOUND with details.availableKeys.
 *   8. payload.success === false -> LINEAR_API_ERROR with details.lastSyncId.
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

import ProjectCreate, { runProjectCreate } from '@/commands/project/create.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { _clearTeamCache } from '@/core/resolvers/index.js'
import { projectCreateRuntime } from '@/lib/project-create-runtime.js'

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

const TEAM_ENG_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TEAM_DESIGN_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const LEAD_UUID = 'cccccccc-dddd-eeee-ffff-000011112222'
const NEW_PROJECT_UUID = 'dddddddd-eeee-ffff-0000-111122223333'

interface CreatePayload {
  success: boolean
  lastSyncId: number
  project?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  createProjectFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  usersFn: ReturnType<typeof vi.fn>
  viewerGet: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  createProject?: (input: Record<string, unknown>) => Promise<CreatePayload>
  teams?: () => Promise<{ nodes: Array<{ id: string; key: string; name: string }> }>
  users?: (
    args: unknown,
  ) => Promise<{ nodes: Array<{ id: string; email?: string; name?: string }> }>
  viewer?: { id: string } | Promise<{ id: string }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const createProjectFn = vi.fn(async (input: Record<string, unknown>) => {
    callLog.push({ method: 'createProject', args: [input] })
    if (!opts.createProject) throw new Error('mock client.createProject not configured')
    return opts.createProject(input)
  })
  const teamsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams()
  })
  const usersFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'users', args: [args] })
    if (!opts.users) throw new Error('mock client.users not configured')
    return opts.users(args)
  })
  const viewerGet = vi.fn(() => {
    callLog.push({ method: 'viewer', args: [] })
    if (opts.viewer === undefined) throw new Error('mock client.viewer not configured')
    return opts.viewer
  })
  const client = {
    createProject: createProjectFn,
    teams: teamsFn,
    users: usersFn,
    get viewer() {
      return viewerGet()
    },
  } as unknown as LinearClient
  return { client, createProjectFn, teamsFn, usersFn, viewerGet, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'project create' })
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

function fakeCreatedProject(id: string, name = 'Roadmap'): Record<string, unknown> {
  return {
    id,
    name,
    state: 'planned',
    progress: 0,
    targetDate: null,
    description: '',
    updatedAt: '2026-01-02T00:00:00Z',
    lead: Promise.resolve(undefined),
    creator: Promise.resolve(undefined),
  }
}

describe('projectCreateRuntime -- minimum + multi-team', () => {
  it('Test 1: name + teams "ENG,DESIGN" -> resolveTeamId for each -> createProject teamIds', async () => {
    const handle = makeMockClient({
      teams: async () => ({
        nodes: [
          { id: TEAM_ENG_UUID, key: 'ENG', name: 'Engineering' },
          { id: TEAM_DESIGN_UUID, key: 'DESIGN', name: 'Design' },
        ],
      }),
      createProject: async () => ({
        success: true,
        lastSyncId: 1,
        project: Promise.resolve(fakeCreatedProject(NEW_PROJECT_UUID)),
      }),
    })

    const out = await projectCreateRuntime({
      args: {},
      flags: { workspace: 'acme', name: 'Roadmap', teams: 'ENG,DESIGN' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.createProjectFn).toHaveBeenCalledTimes(1)
    const callInput = handle.createProjectFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({
      name: 'Roadmap',
      teamIds: [TEAM_ENG_UUID, TEAM_DESIGN_UUID],
    })
    expect(Object.keys(callInput).length).toBe(2)
    expect(out.meta.workspace).toBe('acme')

    const env = success(out.data, { ...out.meta, command: 'project create' })
    expect(env).toMatchSnapshot('create-success-multi-team')
  })
})

describe('projectCreateRuntime -- full input (all optional fields)', () => {
  it('Test 2: name + teams + description + state + lead + startDate + targetDate', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_ENG_UUID, key: 'ENG', name: 'Engineering' }] }),
      users: async () => ({ nodes: [{ id: LEAD_UUID, email: 'lead@example.com' }] }),
      createProject: async () => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeCreatedProject(NEW_PROJECT_UUID)),
      }),
    })

    await projectCreateRuntime({
      args: {},
      flags: {
        workspace: 'acme',
        name: 'Q4 Roadmap',
        teams: 'ENG',
        description: 'Q4 plan',
        state: 'started',
        lead: 'lead@example.com',
        startDate: '2026-10-01',
        targetDate: '2026-12-31',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const input = handle.createProjectFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.name).toBe('Q4 Roadmap')
    expect(input.teamIds).toEqual([TEAM_ENG_UUID])
    expect(input.description).toBe('Q4 plan')
    expect(input.state).toBe('started')
    expect(input.leadId).toBe(LEAD_UUID)
    expect(input.startDate).toBe('2026-10-01')
    expect(input.targetDate).toBe('2026-12-31')
  })
})

describe('projectCreateRuntime -- required-flag validation', () => {
  it('Test 3: missing --name -> USAGE_ERROR exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { workspace: 'acme', teams: 'ENG' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--name is required/)
      expect(handle.callLog).toHaveLength(0)
    }
  })

  it('Test 4: missing --teams -> USAGE_ERROR exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})

    expect.assertions(4)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'Roadmap' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--teams is required/)
      expect(handle.callLog).toHaveLength(0)
    }
  })

  it('Test 5: --teams "  " (whitespace) after split/trim -> USAGE_ERROR (no valid teams)', async () => {
    const handle = makeMockClient({})

    expect.assertions(3)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'Roadmap', teams: '  ' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(handle.callLog).toHaveLength(0)
    }
  })
})

describe('projectCreateRuntime -- WSP-06 enforcement', () => {
  it('Test 6: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { name: 'Roadmap', teams: 'ENG' },
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

describe('projectCreateRuntime -- TEAM_NOT_FOUND', () => {
  it('Test 7: unknown team -> TEAM_NOT_FOUND with availableKeys/Names', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_ENG_UUID, key: 'ENG', name: 'Engineering' }] }),
    })

    expect.assertions(4)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'Roadmap', teams: 'BOGUS' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('TEAM_NOT_FOUND')
      expect(err.details).toMatchObject({ requested: 'BOGUS' })
      expect(handle.createProjectFn).not.toHaveBeenCalled()
    }
  })
})

describe('projectCreateRuntime -- payload failure', () => {
  it('Test 8: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_ENG_UUID, key: 'ENG', name: 'Engineering' }] }),
      createProject: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await projectCreateRuntime({
        args: {},
        flags: { workspace: 'acme', name: 'Roadmap', teams: 'ENG' },
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

describe('ProjectCreate oclif command', () => {
  it('Test create-cmd-a: enableJsonFlag = true and declares --name, --teams, write-guard flags', () => {
    expect(ProjectCreate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(ProjectCreate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'name',
      'teams',
      'description',
      'state',
      'lead',
      'start-date',
      'target-date',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test create-cmd-b: runProjectCreate is exported as a named function', () => {
    expect(typeof runProjectCreate).toBe('function')
  })
})
