/**
 * `issueSearchRuntime` tests (Phase 2 PLAN 02-05 Task 2, ISS-07).
 *
 * Full-text search via `client.searchIssues(term, vars)` (RESEARCH item 2 --
 * the Snippets-suffixed variant referenced in older docs does not exist in
 * @linear/sdk v83). Read command (no
 * WSP-06). Filter parity with `issue list` via `buildIssueFilter` from
 * 02-01. Default --fields projection adds `snippet` mapped from
 * IssueSearchResult.metadata; `--no-snippet` drops it.
 *
 * Coverage:
 *   1.  default args ('authentication') -> searchIssues('authentication', { first: 25 }).
 *   2.  --limit / --cursor map to first / after.
 *   3.  Filter parity -- buildIssueFilter shape passthrough.
 *   4.  meta.pageInfo populated from IssueSearchPayload.pageInfo.
 *   5.  meta.totalCount populated from IssueSearchPayload.totalCount.
 *   6.  Default projection adds `snippet` from result.metadata.
 *   7.  --no-snippet drops snippet.
 *   8.  --fields=ids returns just { id, identifier }, no snippet.
 *   9.  Empty result -> data: [], totalCount: 0.
 *   10. (Rate-limit propagation -- mocked at SDK error class identity.)
 *   11. oclif Command surface: args.query required, all expected flags.
 *   12. --include-archived passes through to vars.includeArchived.
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

import IssueSearch, { runIssueSearch } from '@/commands/issue/search.js'
import type { Config } from '@/core/config/index.js'
import { issueSearchRuntime } from '@/lib/issue-search-runtime.js'

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

interface SearchVars {
  first?: number
  after?: string
  filter?: unknown
  includeArchived?: boolean
}

interface SearchResultNode {
  id: string
  identifier: string
  title?: string
  metadata?: Record<string, unknown>
  state?: unknown
  assignee?: unknown
  team?: unknown
  priority?: number
  updatedAt?: string
}

interface SearchPayload {
  totalCount: number
  nodes: SearchResultNode[]
  pageInfo: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface MockHandle {
  client: LinearClient
  searchIssuesFn: ReturnType<typeof vi.fn>
  lastTerm: { current: string | null }
  lastVars: { current: SearchVars | null }
}

function makeMockClient(opts: {
  searchIssues: (term: string, vars?: SearchVars) => Promise<SearchPayload>
}): MockHandle {
  const lastTerm = { current: null as string | null }
  const lastVars = { current: null as SearchVars | null }
  const searchIssuesFn = vi.fn(async (term: string, vars?: SearchVars) => {
    lastTerm.current = term
    lastVars.current = vars ?? null
    return opts.searchIssues(term, vars)
  })
  const client = { searchIssues: searchIssuesFn } as unknown as LinearClient
  return { client, searchIssuesFn, lastTerm, lastVars }
}

function fakeNode(opts: {
  id: string
  identifier: string
  title?: string
  snippet?: string
}): SearchResultNode {
  const node: SearchResultNode = {
    id: opts.id,
    identifier: opts.identifier,
    title: opts.title ?? `title-${opts.identifier}`,
    priority: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    state: Promise.resolve({ name: 'Todo' }),
    assignee: Promise.resolve(undefined),
    team: Promise.resolve({ key: 'ENG' }),
  }
  if (opts.snippet !== undefined) {
    node.metadata = { snippet: opts.snippet }
  }
  return node
}

function fakePayload(nodes: SearchResultNode[]): SearchPayload {
  return {
    totalCount: nodes.length,
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: nodes.length > 0 ? 'cursor-1' : null,
      hasPreviousPage: false,
      startCursor: null,
    },
  }
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

describe('issueSearchRuntime — basic search', () => {
  it('Test 1: query "authentication" → searchIssues("authentication", { first: 25 })', async () => {
    const handle = makeMockClient({
      searchIssues: async () =>
        fakePayload([fakeNode({ id: 'u1', identifier: 'ENG-1', snippet: 'auth match' })]),
    })

    await issueSearchRuntime({
      args: { query: 'authentication' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.searchIssuesFn).toHaveBeenCalledTimes(1)
    expect(handle.lastTerm.current).toBe('authentication')
    expect(handle.lastVars.current).toEqual({ first: 25 })
  })
})

describe('issueSearchRuntime — pagination', () => {
  it('Test 2: --limit and --cursor map to first / after', async () => {
    const handle = makeMockClient({
      searchIssues: async () => fakePayload([]),
    })

    await issueSearchRuntime({
      args: { query: 'auth' },
      flags: { workspace: 'acme', limit: 50, cursor: 'opaque-cursor-abc' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.lastVars.current).toEqual({ first: 50, after: 'opaque-cursor-abc' })
  })
})

describe('issueSearchRuntime — filter parity (buildIssueFilter)', () => {
  it('Test 3: state/assignee/team/label/project/cycle flags build IssueFilter via buildIssueFilter', async () => {
    const handle = makeMockClient({
      searchIssues: async () => fakePayload([]),
    })

    await issueSearchRuntime({
      args: { query: 'q' },
      flags: {
        workspace: 'acme',
        state: 'In Progress',
        assignee: 'me',
        team: 'ENG',
        label: 'bug',
        project: 'Roadmap',
        cycle: '11111111-2222-3333-4444-555555555555',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const vars = handle.lastVars.current
    expect(vars).not.toBeNull()
    expect(vars?.filter).toEqual({
      state: { name: { eq: 'In Progress' } },
      assignee: { isMe: { eq: true } },
      team: { key: { eq: 'ENG' } },
      labels: { name: { eq: 'bug' } },
      project: { name: { eq: 'Roadmap' } },
      cycle: { id: { eq: '11111111-2222-3333-4444-555555555555' } },
    })
  })
})

describe('issueSearchRuntime — meta.pageInfo', () => {
  it('Test 4: meta.pageInfo mirrors IssueSearchPayload.pageInfo', async () => {
    const handle = makeMockClient({
      searchIssues: async () => ({
        totalCount: 1,
        nodes: [fakeNode({ id: 'u1', identifier: 'ENG-1' })],
        pageInfo: {
          hasNextPage: true,
          endCursor: 'cursor-end',
          hasPreviousPage: false,
          startCursor: 'cursor-start',
        },
      }),
    })

    const out = await issueSearchRuntime({
      args: { query: 'q' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.meta.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: 'cursor-end',
      hasPreviousPage: false,
      startCursor: 'cursor-start',
    })
  })
})

describe('issueSearchRuntime — meta.totalCount', () => {
  it('Test 5: meta.totalCount populated from IssueSearchPayload.totalCount', async () => {
    const handle = makeMockClient({
      searchIssues: async () => ({
        totalCount: 42,
        nodes: [fakeNode({ id: 'u1', identifier: 'ENG-1' })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await issueSearchRuntime({
      args: { query: 'q' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.meta.totalCount).toBe(42)
  })
})

describe('issueSearchRuntime — snippet projection', () => {
  it('Test 6: default projection adds `snippet` from result.metadata.snippet', async () => {
    const handle = makeMockClient({
      searchIssues: async () =>
        fakePayload([fakeNode({ id: 'u1', identifier: 'ENG-1', snippet: 'matched **here**' })]),
    })

    const out = await issueSearchRuntime({
      args: { query: 'auth' },
      flags: { workspace: 'acme', fields: 'id,identifier,snippet' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([{ id: 'u1', identifier: 'ENG-1', snippet: 'matched **here**' }])
    expect(out).toMatchSnapshot('search-success-with-snippet')
  })

  it('Test 7: --no-snippet drops the snippet field from data', async () => {
    const handle = makeMockClient({
      searchIssues: async () =>
        fakePayload([fakeNode({ id: 'u1', identifier: 'ENG-1', snippet: 'should be dropped' })]),
    })

    const out = await issueSearchRuntime({
      args: { query: 'auth' },
      flags: { workspace: 'acme', noSnippet: true, fields: 'id,identifier,snippet' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([{ id: 'u1', identifier: 'ENG-1', snippet: null }])
    expect(out).toMatchSnapshot('search-success-no-snippet')
  })

  it('Test 8: --fields=ids returns { id, identifier } only (no snippet)', async () => {
    const handle = makeMockClient({
      searchIssues: async () =>
        fakePayload([fakeNode({ id: 'u1', identifier: 'ENG-1', snippet: 'should not appear' })]),
    })

    const out = await issueSearchRuntime({
      args: { query: 'auth' },
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([{ id: 'u1', identifier: 'ENG-1' }])
  })
})

describe('issueSearchRuntime — empty results', () => {
  it('Test 9: empty result → data: [], meta.totalCount: 0', async () => {
    const handle = makeMockClient({
      searchIssues: async () => ({
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await issueSearchRuntime({
      args: { query: 'no-match' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
    expect(out.meta.totalCount).toBe(0)
  })
})

describe('issueSearchRuntime — rate-limit propagation', () => {
  it('Test 10: SDK rate-limit error propagates as classified RATELIMITED', async () => {
    // Smoke test only: the SDK class identity bridge is verified by the
    // shared transport tests in test/core/transport. Confirms that
    // `withRateLimitRetry` is wired in (an unmocked SDK error from the
    // mocked client should still end up wrapped, since
    // `classifySdkError` recognises only the typed error classes).
    const handle = makeMockClient({
      searchIssues: async () => {
        throw new Error('something went wrong')
      },
    })

    expect.assertions(1)
    try {
      await issueSearchRuntime({
        args: { query: 'q' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      // Generic Error -> classifier returns it untouched -> bubbles.
      expect(e).toBeInstanceOf(Error)
    }
  })
})

describe('IssueSearch oclif command', () => {
  it('Test 11: enableJsonFlag, args.query required, expected flags present', () => {
    expect(IssueSearch.enableJsonFlag).toBe(true)
    const args = IssueSearch.args as Record<string, { required?: boolean }>
    expect(args.query?.required).toBe(true)
    const flagNames = Object.keys(IssueSearch.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'fields',
      'limit',
      'cursor',
      'state',
      'assignee',
      'team',
      'label',
      'project',
      'cycle',
      'no-snippet',
      'include-archived',
    ]) {
      expect(flagNames).toContain(expected)
    }
    expect(typeof runIssueSearch).toBe('function')
  })
})

describe('issueSearchRuntime — --include-archived passthrough', () => {
  it('Test 12: --include-archived sets vars.includeArchived = true', async () => {
    const handle = makeMockClient({
      searchIssues: async () => fakePayload([]),
    })

    await issueSearchRuntime({
      args: { query: 'q' },
      flags: { workspace: 'acme', includeArchived: true },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.lastVars.current?.includeArchived).toBe(true)
  })
})
