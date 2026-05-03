/**
 * `labelListRuntime` tests (Phase 2 PLAN 02-09 Task 2, LBL-01.list).
 *
 * Coverage:
 *   1. No filter -> client.issueLabels({ first: 25 }).
 *   2. --team ENG -> filter: { team: { key: { eq: 'ENG' } } } (no resolver round-trip).
 *   3. Pagination -- --limit 5 --cursor x -> { first: 5, after: 'x' }.
 *   4. Default projection lazy-hydrates label.team and label.parent.
 *   5. Empty list returns data: [].
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

import LabelList, { runLabelList } from '@/commands/label/list.js'
import type { Config } from '@/core/config/index.js'
import { success } from '@/core/output/index.js'
import { labelListRuntime } from '@/lib/label-list-runtime.js'

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
  issueLabelsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issueLabels?: (args: Record<string, unknown>) => Promise<SdkConnection>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const issueLabelsFn = vi.fn(async (args: Record<string, unknown>) => {
    callLog.push({ method: 'issueLabels', args: [args] })
    if (!opts.issueLabels) throw new Error('mock client.issueLabels not configured')
    return opts.issueLabels(args)
  })
  const client = { issueLabels: issueLabelsFn } as unknown as LinearClient
  return { client, issueLabelsFn, callLog }
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

function makeLabelNode(): Record<string, unknown> {
  return {
    id: 'label-uuid-1',
    name: 'p0',
    color: '#ff0000',
    description: 'highest priority',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    team: Promise.resolve({ id: 'team-uuid-1', key: 'ENG', name: 'Engineering' }),
    parent: Promise.resolve(undefined),
  }
}

describe('labelListRuntime -- no filter', () => {
  it('Test 1: no --team -> client.issueLabels({ first: 25 }) (no filter)', async () => {
    const handle = makeMockClient({
      issueLabels: async () => ({
        nodes: [makeLabelNode()],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await labelListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issueLabelsFn).toHaveBeenCalledTimes(1)
    expect(handle.issueLabelsFn.mock.calls[0]?.[0]).toEqual({ first: 25 })

    const env = success(out.data, { ...out.meta, command: 'label list' })
    expect(env).toMatchSnapshot('list-success-no-filter')
  })
})

describe('labelListRuntime -- team filter inline routing', () => {
  it('Test 2: --team ENG -> filter: { team: { key: { eq: "ENG" } } } (no SDK round-trip)', async () => {
    const handle = makeMockClient({
      issueLabels: async () => ({ nodes: [], pageInfo: undefined }),
    })

    await labelListRuntime({
      flags: { workspace: 'acme', team: 'eng' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const args = handle.issueLabelsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args).toMatchObject({
      first: 25,
      filter: { team: { key: { eq: 'ENG' } } },
    })
  })
})

describe('labelListRuntime -- pagination', () => {
  it('Test 3: --limit 5 --cursor x -> { first: 5, after: "x" }', async () => {
    const handle = makeMockClient({
      issueLabels: async () => ({ nodes: [] }),
    })

    await labelListRuntime({
      flags: { workspace: 'acme', limit: 5, cursor: 'x' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issueLabelsFn.mock.calls[0]?.[0]).toEqual({ first: 5, after: 'x' })
  })
})

describe('labelListRuntime -- projection (lazy hydration)', () => {
  it('Test 4: defaults preset awaits label.team and label.parent', async () => {
    const handle = makeMockClient({
      issueLabels: async () => ({ nodes: [makeLabelNode()] }),
    })

    const out = await labelListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const projected = (out.data as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    // team.key should be projected
    expect((projected.team as Record<string, unknown>).key).toBe('ENG')
    // parent.name should be null since parent resolved to undefined
    expect((projected.parent as Record<string, unknown>).name).toBeNull()
  })
})

describe('labelListRuntime -- empty list', () => {
  it('Test 5: empty connection returns data: []', async () => {
    const handle = makeMockClient({
      issueLabels: async () => ({ nodes: [] }),
    })

    const out = await labelListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
  })
})

describe('LabelList oclif command', () => {
  it('Test 5a: enableJsonFlag = true and declares pagination + workspace + fields + team flags', () => {
    expect(LabelList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(LabelList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor', 'team']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 5b: runLabelList is exported as a named function', () => {
    expect(typeof runLabelList).toBe('function')
  })
})
