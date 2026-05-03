/**
 * `projectUpdateRuntime` tests (Phase 2 PLAN 02-07 Task 2, PRJ-01.update).
 *
 * Coverage:
 *   9.  UUID input -- updateProject('<uuid>', { name }) directly.
 *   10. Name input -- resolveProjectId first, then updateProject(uuid, ...).
 *   11. VALIDATION_NO_FIELDS -- no field flags BEFORE any SDK call.
 *   12. WSP-06 enforcement BEFORE any SDK call.
 *   13. payload.success === false -> LINEAR_API_ERROR.
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

import ProjectUpdate, { runProjectUpdate } from '@/commands/project/update.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { _clearProjectCache } from '@/core/resolvers/index.js'
import { projectUpdateRuntime } from '@/lib/project-update-runtime.js'

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
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  updateProject?: (id: string, input: Record<string, unknown>) => Promise<UpdatePayload>
  projects?: () => Promise<{ nodes: Array<{ id: string; name: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const updateProjectFn = vi.fn(async (id: string, input: Record<string, unknown>) => {
    callLog.push({ method: 'updateProject', args: [id, input] })
    if (!opts.updateProject) throw new Error('mock client.updateProject not configured')
    return opts.updateProject(id, input)
  })
  const updateProjectStatusFn = vi.fn(async (..._args: unknown[]) => {
    callLog.push({ method: 'updateProjectStatus', args: _args })
    throw new Error('updateProjectStatus must NOT be called by project update')
  })
  const projectsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projects', args: [args] })
    if (!opts.projects) throw new Error('mock client.projects not configured')
    return opts.projects()
  })
  const client = {
    updateProject: updateProjectFn,
    updateProjectStatus: updateProjectStatusFn,
    projects: projectsFn,
  } as unknown as LinearClient
  return { client, updateProjectFn, updateProjectStatusFn, projectsFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'project update' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearProjectCache()
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
    name: 'New',
    state: 'started',
    progress: 0,
    targetDate: null,
    description: '',
    updatedAt: '2026-01-02T00:00:00Z',
    lead: Promise.resolve(undefined),
    creator: Promise.resolve(undefined),
  }
}

describe('projectUpdateRuntime -- UUID input', () => {
  it('Test 9: UUID + --name -> updateProject(uuid, { name }); resolveProjectId NOT called', async () => {
    const handle = makeMockClient({
      updateProject: async (id) => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeUpdatedProject(id)),
      }),
    })

    const out = await projectUpdateRuntime({
      args: { ref: PROJECT_UUID },
      flags: { workspace: 'acme', name: 'New' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateProjectFn).toHaveBeenCalledTimes(1)
    expect(handle.updateProjectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
    expect(handle.updateProjectFn.mock.calls[0]?.[1]).toEqual({ name: 'New' })
    expect(handle.projectsFn).not.toHaveBeenCalled()
    expect(out.meta.workspace).toBe('acme')

    const env = success(out.data, { ...out.meta, command: 'project update' })
    expect(env).toMatchSnapshot('update-success-uuid-name-only')
  })
})

describe('projectUpdateRuntime -- name input', () => {
  it('Test 10: name + --name "New" -> resolveProjectId then updateProject(uuid, ...)', async () => {
    const handle = makeMockClient({
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: PROJECT_NAME }] }),
      updateProject: async (id) => ({
        success: true,
        lastSyncId: 100,
        project: Promise.resolve(fakeUpdatedProject(id)),
      }),
    })

    await projectUpdateRuntime({
      args: { ref: PROJECT_NAME },
      flags: { workspace: 'acme', name: 'New' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.projectsFn).toHaveBeenCalledTimes(1)
    expect(handle.updateProjectFn).toHaveBeenCalledTimes(1)
    expect(handle.updateProjectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
  })
})

describe('projectUpdateRuntime -- VALIDATION_NO_FIELDS', () => {
  it('Test 11: no field flags -> VALIDATION_NO_FIELDS exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await projectUpdateRuntime({
        args: { ref: PROJECT_UUID },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('VALIDATION_NO_FIELDS')
      expect(err.message).toMatch(/pass at least one of/)
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-VALIDATION_NO_FIELDS')
    }
  })
})

describe('projectUpdateRuntime -- WSP-06 enforcement', () => {
  it('Test 12: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await projectUpdateRuntime({
        args: { ref: PROJECT_UUID },
        flags: { name: 'New' },
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
    }
  })
})

describe('projectUpdateRuntime -- payload failure', () => {
  it('Test 13: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      updateProject: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await projectUpdateRuntime({
        args: { ref: PROJECT_UUID },
        flags: { workspace: 'acme', name: 'New' },
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

describe('ProjectUpdate oclif command', () => {
  it('Test update-cmd-a: enableJsonFlag = true; declares --name and write-guard flags', () => {
    expect(ProjectUpdate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(ProjectUpdate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'name',
      'description',
      'state',
      'lead',
      'target-date',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test update-cmd-b: runProjectUpdate is exported as a named function', () => {
    expect(typeof runProjectUpdate).toBe('function')
  })
})
