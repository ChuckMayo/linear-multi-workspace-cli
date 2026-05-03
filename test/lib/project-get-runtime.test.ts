/**
 * `projectGetRuntime` tests (Phase 2 PLAN 02-07 Task 1, PRJ-01.get).
 *
 * Coverage:
 *   5. UUID input -- client.project(uuid) directly; no resolveProjectId call.
 *   6. Name input -- resolveProjectId(workspace, name) -> uuid, then client.project(uuid).
 *   7. PROJECT_NOT_FOUND -- resolver throws (unknown project name); details.available propagated.
 *   8. UUID input but client.project returns undefined -> throws PROJECT_NOT_FOUND.
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

import ProjectGet, { runProjectGet } from '@/commands/project/get.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { _clearProjectCache } from '@/core/resolvers/index.js'
import { projectGetRuntime } from '@/lib/project-get-runtime.js'

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

interface MockHandle {
  client: LinearClient
  projectFn: ReturnType<typeof vi.fn>
  projectsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  project?: (id: string) => Promise<Record<string, unknown> | null | undefined>
  projects?: () => Promise<{ nodes: Array<{ id: string; name: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const projectFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'project', args: [id] })
    if (!opts.project) throw new Error('mock client.project not configured')
    return opts.project(id)
  })
  const projectsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projects', args: [args] })
    if (!opts.projects) throw new Error('mock client.projects not configured')
    return opts.projects()
  })
  const client = {
    project: projectFn,
    projects: projectsFn,
  } as unknown as LinearClient
  return { client, projectFn, projectsFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'project get' })
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

function fakeProject(id: string, name = PROJECT_NAME): Record<string, unknown> {
  return {
    id,
    name,
    state: 'started',
    progress: 0.25,
    targetDate: '2026-12-31',
    description: 'Roadmap',
    updatedAt: '2026-01-02T00:00:00Z',
    lead: Promise.resolve({ email: 'lead@example.com', name: 'Alice' }),
    creator: Promise.resolve({ email: 'creator@example.com', name: 'Bob' }),
  }
}

describe('projectGetRuntime -- UUID input', () => {
  it('Test 5: UUID -> client.project(uuid) directly; resolveProjectId is NOT called', async () => {
    const handle = makeMockClient({
      project: async () => fakeProject(PROJECT_UUID),
    })

    const out = await projectGetRuntime({
      args: { ref: PROJECT_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.projectFn).toHaveBeenCalledTimes(1)
    expect(handle.projectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
    // No bulk projects() lookup -- UUID short-circuits.
    expect(handle.projectsFn).not.toHaveBeenCalled()
    expect(out.meta.workspace).toBe('acme')

    expect(out).toMatchSnapshot('get-success-uuid')
  })
})

describe('projectGetRuntime -- name input', () => {
  it('Test 6: name -> resolveProjectId via client.projects(), then client.project(uuid)', async () => {
    const handle = makeMockClient({
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: PROJECT_NAME }] }),
      project: async () => fakeProject(PROJECT_UUID),
    })

    await projectGetRuntime({
      args: { ref: PROJECT_NAME },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.projectsFn).toHaveBeenCalledTimes(1)
    expect(handle.projectFn).toHaveBeenCalledTimes(1)
    expect(handle.projectFn.mock.calls[0]?.[0]).toBe(PROJECT_UUID)
  })
})

describe('projectGetRuntime -- PROJECT_NOT_FOUND', () => {
  it('Test 7: unknown name -> resolver throws PROJECT_NOT_FOUND with details.available', async () => {
    const handle = makeMockClient({
      projects: async () => ({
        nodes: [
          { id: 'p1', name: 'Roadmap Q1' },
          { id: 'p2', name: 'Platform' },
        ],
      }),
    })

    expect.assertions(5)
    try {
      await projectGetRuntime({
        args: { ref: 'BogusProject' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('PROJECT_NOT_FOUND')
      expect(err.details).toMatchObject({
        requested: 'BogusProject',
        available: ['platform', 'roadmap q1'],
      })
      // client.project should never have been called -- resolver fails first.
      expect(handle.projectFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-PROJECT_NOT_FOUND')
    }
  })
})

describe('projectGetRuntime -- UUID-not-found', () => {
  it('Test 8: UUID input but client.project returns null/undefined -> PROJECT_NOT_FOUND', async () => {
    const handle = makeMockClient({
      project: async () => null,
    })

    expect.assertions(3)
    try {
      await projectGetRuntime({
        args: { ref: PROJECT_UUID },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('PROJECT_NOT_FOUND')
      expect(err.details).toMatchObject({ ref: PROJECT_UUID })
    }
  })
})

describe('ProjectGet oclif command', () => {
  it('Test get-cmd-a: enableJsonFlag = true and declares workspace, fields', () => {
    expect(ProjectGet.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(ProjectGet.flags)
    for (const expected of ['pretty', 'workspace', 'fields']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test get-cmd-b: runProjectGet is exported as a named function', () => {
    expect(typeof runProjectGet).toBe('function')
  })
})
