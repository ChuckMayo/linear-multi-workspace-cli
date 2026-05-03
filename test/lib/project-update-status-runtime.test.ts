/**
 * `projectUpdateStatusRuntime` tests (Phase 2 PLAN 02-07 Task 2,
 * PRJ-01.update-status).
 *
 * **CRITICAL** -- this runtime sets a project's CURRENT status via
 * `client.updateProject(id, { statusId })`. It MUST NOT call
 * `client.updateProjectStatus()` which mutates the workspace-level status
 * DEFINITION (admin operation, out of scope per RESEARCH § Pitfall 5).
 *
 * Coverage:
 *   14. Resolves project ref + status name -> updateProject(projectId, { statusId }).
 *   15. updateProjectStatus is NEVER called (call count = 0).
 *   16. Both args UUID -> resolvers passthrough; updateProject(projUuid, { statusId: statusUuid }).
 *   17. Unknown status -> PROJECT_NOT_FOUND (resolver re-uses code with disambiguating message).
 *   18. WSP-06 enforcement BEFORE any SDK call.
 *   19. payload.success === false -> LINEAR_API_ERROR.
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

import ProjectUpdateStatus, { runProjectUpdateStatus } from '@/commands/project/update-status.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { _clearProjectCache, _clearProjectStatusCache } from '@/core/resolvers/index.js'
import { projectUpdateStatusRuntime } from '@/lib/project-update-status-runtime.js'

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

const PROJECT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PROJECT_NAME = 'Roadmap Q1'
const STATUS_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const STATUS_NAME = 'At Risk'

interface UpdatePayload {
  success: boolean
  lastSyncId: number
  project?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  updateProjectFn: ReturnType<typeof vi.fn>
  updateProjectStatusFn: ReturnType<typeof vi.fn>
  projectsFn: ReturnType<typeof vi.fn>
  projectStatusesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  updateProject?: (id: string, input: Record<string, unknown>) => Promise<UpdatePayload>
  projects?: () => Promise<{ nodes: Array<{ id: string; name: string }> }>
  projectStatuses?: () => Promise<{ nodes: Array<{ id: string; name: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const updateProjectFn = vi.fn(async (id: string, input: Record<string, unknown>) => {
    callLog.push({ method: 'updateProject', args: [id, input] })
    if (!opts.updateProject) throw new Error('mock client.updateProject not configured')
    return opts.updateProject(id, input)
  })
  // The whole point of Test 15: this MUST never be called by the runtime.
  // We track every invocation in callLog, but unlike the other mocks we do
  // NOT throw -- the test asserts call-count = 0 directly.
  const updateProjectStatusFn = vi.fn(async (..._args: unknown[]) => {
    callLog.push({ method: 'updateProjectStatus', args: _args })
    return { success: true, lastSyncId: 0 }
  })
  const projectsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projects', args: [args] })
    if (!opts.projects) throw new Error('mock client.projects not configured')
    return opts.projects()
  })
  const projectStatusesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projectStatuses', args: [args] })
    if (!opts.projectStatuses) throw new Error('mock client.projectStatuses not configured')
    return opts.projectStatuses()
  })
  const client = {
    updateProject: updateProjectFn,
    updateProjectStatus: updateProjectStatusFn,
    projects: projectsFn,
    projectStatuses: projectStatusesFn,
  } as unknown as LinearClient
  return {
    client,
    updateProjectFn,
    updateProjectStatusFn,
    projectsFn,
    projectStatusesFn,
    callLog,
  }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'project update-status' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearProjectCache()
  _clearProjectStatusCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

function fakeUpdatedProject(id: string): Record<string, unknown> {
  return {
    id,
    name: PROJECT_NAME,
    state: 'started',
    progress: 0,
    targetDate: null,
    description: '',
    updatedAt: '2026-01-02T00:00:00Z',
    lead: Promise.resolve(undefined),
    creator: Promise.resolve(undefined),
  }
}

describe('projectUpdateStatusRuntime -- happy path', () => {
  it('Test 14: name + status name -> resolveProjectId + resolveProjectStatusId -> updateProject({ statusId })', async () => {
    const handle = makeMockClient({
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: PROJECT_NAME }] }),
      projectStatuses: async () => ({ nodes: [{ id: STATUS_UUID, name: STATUS_NAME }] }),
      updateProject: async (id) => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeUpdatedProject(id)),
      }),
    })

    const out = await projectUpdateStatusRuntime({
      args: { ref: PROJECT_NAME, status: STATUS_NAME },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.projectsFn).toHaveBeenCalledTimes(1)
    expect(handle.projectStatusesFn).toHaveBeenCalledTimes(1)
    expect(handle.updateProjectFn).toHaveBeenCalledTimes(1)
    // EXACT call shape: client.updateProject(projectId, { statusId })
    expect(handle.updateProjectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
    expect(handle.updateProjectFn.mock.calls[0]?.[1]).toEqual({ statusId: STATUS_UUID })

    const env = success(out.data, { ...out.meta, command: 'project update-status' })
    expect(env).toMatchSnapshot('update-status-success')
  })

  it('Test 15: updateProjectStatus is NEVER called (mutates the DEFINITION, not the project)', async () => {
    const handle = makeMockClient({
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: PROJECT_NAME }] }),
      projectStatuses: async () => ({ nodes: [{ id: STATUS_UUID, name: STATUS_NAME }] }),
      updateProject: async (id) => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeUpdatedProject(id)),
      }),
    })

    await projectUpdateStatusRuntime({
      args: { ref: PROJECT_NAME, status: STATUS_NAME },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateProjectStatusFn).not.toHaveBeenCalled()
    expect(handle.callLog.filter((c) => c.method === 'updateProjectStatus')).toHaveLength(0)
  })
})

describe('projectUpdateStatusRuntime -- UUID passthrough', () => {
  it('Test 16: both args UUID -> resolvers passthrough; updateProject(projUuid, { statusId: statusUuid })', async () => {
    const handle = makeMockClient({
      updateProject: async (id) => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeUpdatedProject(id)),
      }),
    })

    await projectUpdateStatusRuntime({
      args: { ref: PROJECT_UUID, status: STATUS_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // No bulk lookups needed (both UUIDs).
    expect(handle.projectsFn).not.toHaveBeenCalled()
    expect(handle.projectStatusesFn).not.toHaveBeenCalled()
    // EXACT call shape preserved.
    expect(handle.updateProjectFn).toHaveBeenCalledTimes(1)
    expect(handle.updateProjectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
    expect(handle.updateProjectFn.mock.calls[0]?.[1]).toEqual({ statusId: STATUS_UUID })
  })
})

describe('projectUpdateStatusRuntime -- PROJECT_NOT_FOUND on unknown status', () => {
  it('Test 17: unknown status name -> PROJECT_NOT_FOUND (resolver re-uses code with disambiguating message)', async () => {
    const handle = makeMockClient({
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: PROJECT_NAME }] }),
      projectStatuses: async () => ({
        nodes: [
          { id: 's1', name: 'On Track' },
          { id: 's2', name: 'At Risk' },
        ],
      }),
    })

    expect.assertions(5)
    try {
      await projectUpdateStatusRuntime({
        args: { ref: PROJECT_NAME, status: 'BogusStatus' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('PROJECT_NOT_FOUND')
      expect(err.message).toMatch(/project status not found/)
      expect(err.details).toMatchObject({ requested: 'BogusStatus' })
      // Mutation never called.
      expect(handle.updateProjectFn).not.toHaveBeenCalled()
    }
  })
})

describe('projectUpdateStatusRuntime -- WSP-06', () => {
  it('Test 18: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await projectUpdateStatusRuntime({
        args: { ref: PROJECT_UUID, status: STATUS_UUID },
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

describe('projectUpdateStatusRuntime -- payload failure', () => {
  it('Test 19: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      updateProject: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await projectUpdateStatusRuntime({
        args: { ref: PROJECT_UUID, status: STATUS_UUID },
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

describe('ProjectUpdateStatus oclif command', () => {
  it('Test update-status-cmd-a: enableJsonFlag = true; declares write-guard flags + args', () => {
    expect(ProjectUpdateStatus.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(ProjectUpdateStatus.flags)
    for (const expected of ['pretty', 'workspace', 'allow-active-workspace-write', 'fields']) {
      expect(flagNames).toContain(expected)
    }
    // Args: ref + status both required positionals.
    const argNames = Object.keys(ProjectUpdateStatus.args)
    for (const expected of ['ref', 'status']) {
      expect(argNames).toContain(expected)
    }
  })

  it('Test update-status-cmd-b: runProjectUpdateStatus is exported as a named function', () => {
    expect(typeof runProjectUpdateStatus).toBe('function')
  })
})
