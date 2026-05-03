/**
 * `projectListRuntime` tests (Phase 2 PLAN 02-07 Task 1, PRJ-01.list).
 *
 * Coverage:
 *   1. Workspace-wide list -- client.projects({ first: 25 }), default preset
 *      lazy-hydrates lead.
 *   2. Pagination -- --limit 10 --cursor token -> { first: 10, after: 'token' }.
 *   3. Lazy hydration -- defaults preset awaits lead promise (default preset
 *      includes `lead.email`).
 *   4. Empty result -> data: [].
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

import ProjectList, { runProjectList } from '@/commands/project/list.js'
import type { Config } from '@/core/config/index.js'
import { success } from '@/core/output/index.js'
import { projectListRuntime } from '@/lib/project-list-runtime.js'

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

const PROJECT_UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PROJECT_UUID_2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

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
  projectsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  projects?: (args: unknown) => Promise<SdkConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const projectsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projects', args: [args] })
    if (!opts.projects) throw new Error('mock client.projects not configured')
    return opts.projects(args)
  })
  const client = {
    projects: projectsFn,
  } as unknown as LinearClient
  return { client, projectsFn, callLog }
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

function fakeProject(id: string, name = 'Roadmap Q1'): Record<string, unknown> {
  return {
    id,
    name,
    state: 'started',
    progress: 0.5,
    targetDate: '2026-12-31',
    description: 'Half-year roadmap',
    updatedAt: '2026-01-02T00:00:00Z',
    lead: Promise.resolve({ email: 'lead@example.com', name: 'Alice' }),
    creator: Promise.resolve({ email: 'creator@example.com', name: 'Bob' }),
  }
}

describe('projectListRuntime -- workspace-wide', () => {
  it('Test 1: client.projects({ first: 25 }) with no filter; lead is hydrated for default preset', async () => {
    const handle = makeMockClient({
      projects: async () => ({
        nodes: [fakeProject(PROJECT_UUID_1)],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await projectListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.projectsFn).toHaveBeenCalledTimes(1)
    const args = handle.projectsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(25)
    expect(args.after).toBeUndefined()
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(Array.isArray(out.data)).toBe(true)
    expect((out.data as unknown[]).length).toBe(1)

    const env = success(out.data, { ...out.meta, command: 'project list' })
    expect(env).toMatchSnapshot('list-success-workspace-wide')
  })
})

describe('projectListRuntime -- pagination', () => {
  it('Test 2: --limit 10 --cursor token -> { first: 10, after: "token" }', async () => {
    const handle = makeMockClient({
      projects: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await projectListRuntime({
      flags: { workspace: 'acme', limit: 10, cursor: 'opaque-token-abc' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const args = handle.projectsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(10)
    expect(args.after).toBe('opaque-token-abc')
  })
})

describe('projectListRuntime -- lazy hydration on defaults preset', () => {
  it('Test 3: --fields=defaults awaits lead on each node; default preset includes lead.email', async () => {
    // Use property getters so we can detect whether the runtime touched the
    // lazy relation at all. A plain `Promise.resolve().then(...)` would
    // schedule the .then() callback as a microtask regardless of whether
    // we awaited the value -- which makes "did the runtime even read this
    // property" untestable. With a getter, accessing the property at all
    // (let alone awaiting it) calls the spy.
    const leadGetSpy = vi.fn(() => Promise.resolve({ email: 'l@example.com', name: 'L' }))
    const creatorGetSpy = vi.fn(() => Promise.resolve({ email: 'c@example.com', name: 'C' }))
    const node: Record<string, unknown> = Object.defineProperties(
      {
        id: PROJECT_UUID_2,
        name: 'Hydrated',
        state: 'planned',
        progress: 0,
        targetDate: null,
        description: '',
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        lead: { enumerable: true, configurable: true, get: leadGetSpy },
        creator: { enumerable: true, configurable: true, get: creatorGetSpy },
      },
    )
    const handle = makeMockClient({
      projects: async () => ({
        nodes: [node],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await projectListRuntime({
      flags: { workspace: 'acme', fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // defaults preset references `lead.email` (per FIELD_PRESETS.project) --
    // the runtime touched the lead getter to await it.
    expect(leadGetSpy).toHaveBeenCalled()
    // defaults preset does NOT reference creator -- runtime must not even
    // read the property.
    expect(creatorGetSpy).not.toHaveBeenCalled()
    const projected = (out.data as Array<Record<string, unknown>>)[0]
    expect(projected).toBeDefined()
    expect((projected as Record<string, unknown>).id).toBe(PROJECT_UUID_2)
    expect((projected as Record<string, Record<string, unknown>>).lead?.email).toBe('l@example.com')
  })
})

describe('projectListRuntime -- empty result', () => {
  it('Test 4: empty connection -> data: []', async () => {
    const handle = makeMockClient({
      projects: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await projectListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
  })
})

describe('ProjectList oclif command', () => {
  it('Test list-cmd-a: enableJsonFlag = true and declares workspace, fields, limit, cursor', () => {
    expect(ProjectList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(ProjectList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test list-cmd-b: runProjectList is exported as a named function', () => {
    expect(typeof runProjectList).toBe('function')
  })
})
