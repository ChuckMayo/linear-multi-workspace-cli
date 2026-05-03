/**
 * `issue list` runtime + command tests (Phase 1 PLAN-05, ISS-01, KRN-08, KRN-09).
 *
 * Test seam: tests call `issueListRuntime` directly with a synthetic
 * `clientFactoryOverride` and `loadConfigOverride`. The oclif Command class is
 * tested only at the surface level (`enableJsonFlag`, flag presence, --help).
 *
 * Mock pattern: each test sets `mockIssuesImpl(fn)` which becomes the body of
 * the mocked `client.issues(...)` call. Errors are thrown via the function
 * body rather than via `vi.mock` reject — keeps the per-test contract local.
 *
 * KRN-09 coverage: Tests 9-14 fault-inject one error per code in the
 * taxonomy (10/11/12/13/14/15) and snapshot the failure envelope. After
 * Phase 2 PLAN 02-01, the canonical classifier is `classifySdkError` in
 * `src/core/transport/rate-limit.ts` and discriminates on `instanceof` of
 * the `@linear/sdk` typed error classes — so these tests now throw real
 * SDK error class instances (`RatelimitedLinearError`,
 * `AuthenticationLinearError`, `NetworkLinearError`,
 * `InvalidInputLinearError`, plain `LinearError`) instead of plain
 * `Error("AuthenticationError: ...")` regex bait.
 */
import { execFileSync } from 'node:child_process'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub @linear/sdk BEFORE importing modules that consume it. The transport
// module imports the typed error classes from this same path, so the mock
// must EXPORT them — otherwise `instanceof RatelimitedLinearError` in the
// transport always returns false (the import resolves to `undefined`).
vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    complexityRemaining?: number
    complexityLimit?: number
    complexityResetAt?: number | Date
    constructor(opts?: {
      message?: string
      retryAfter?: number
      complexityRemaining?: number
      complexityLimit?: number
      complexityResetAt?: number | Date
    }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
      if (opts?.complexityRemaining !== undefined)
        this.complexityRemaining = opts.complexityRemaining
      if (opts?.complexityLimit !== undefined) this.complexityLimit = opts.complexityLimit
      if (opts?.complexityResetAt !== undefined) this.complexityResetAt = opts.complexityResetAt
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
      async issues(args: { first?: number; after?: string; filter?: unknown }): Promise<unknown> {
        if (!mockIssuesFn) throw new Error('mockIssuesFn not configured')
        return mockIssuesFn(args)
      }
    },
  }
})

type IssuesArgs = { first?: number; after?: string; filter?: unknown }
let mockIssuesFn: ((args: IssuesArgs) => Promise<unknown>) | null = null
let lastIssuesArgs: IssuesArgs | null = null

function setMockIssues(fn: (args: IssuesArgs) => Promise<unknown>): void {
  mockIssuesFn = async (args) => {
    lastIssuesArgs = args
    return fn(args)
  }
}

function clearMockIssues(): void {
  mockIssuesFn = null
  lastIssuesArgs = null
}

import {
  AuthenticationLinearError as RealAuthenticationLinearError,
  InternalLinearError as RealInternalLinearError,
  InvalidInputLinearError as RealInvalidInputLinearError,
  NetworkLinearError as RealNetworkLinearError,
  RatelimitedLinearError as RealRatelimitedLinearError,
} from '@linear/sdk'
import IssueList from '@/commands/issue/list.js'
// Stub config — pure object so tests don't touch the filesystem. Shape
// matches the `Config` type from `@/core/config/index.js` so the runtime
// signature accepts the override without casting.
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { issueListRuntime } from '@/lib/issue-list-runtime.js'

// vi.mock above replaces @linear/sdk at module-load with our own classes
// whose constructors accept a test-friendly options bag. Cast away the
// real SDK constructor signature for the mock-construction call sites.
type RatelimitedLinearErrorOpts = {
  message?: string
  retryAfter?: number
  complexityRemaining?: number
  complexityLimit?: number
  complexityResetAt?: number | Date
}
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (
  opts?: RatelimitedLinearErrorOpts,
) => Error
const NetworkLinearError = RealNetworkLinearError as unknown as new (msg?: string) => Error
const AuthenticationLinearError = RealAuthenticationLinearError as unknown as new (
  msg?: string,
) => Error
const InvalidInputLinearError = RealInvalidInputLinearError as unknown as new (
  msg?: string,
) => Error
const InternalLinearError = RealInternalLinearError as unknown as new (msg?: string) => Error

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

const EMPTY_CONFIG: Config = { active: null, workspaces: {} }

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  clearMockIssues()
  // Strip any leaked env vars that might affect resolver precedence.
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

// -----------------------------------------------------------------------------
// Mock helpers — build SDK-shaped Issue objects with lazy state/assignee/team
// promises (matching @linear/sdk v83's "related entities are async getters").
// -----------------------------------------------------------------------------

interface SdkIssueOpts {
  id: string
  identifier: string
  title?: string
  priority?: number
  updatedAt?: string
  state?: { id?: string; name: string; type?: string }
  assignee?: { id?: string; email: string; name?: string }
  team?: { id?: string; key: string; name?: string }
  description?: string | null
  url?: string
}

function sdkIssue(opts: SdkIssueOpts): Record<string, unknown> {
  // Use property accessors so awaiting `issue.state` yields the nested record.
  // Plain objects with promise values match @linear/sdk's runtime shape closely
  // enough for the runtime's hydrator (which `await`s each related entity).
  const issue: Record<string, unknown> = {
    id: opts.id,
    identifier: opts.identifier,
    title: opts.title ?? `title-${opts.identifier}`,
    priority: opts.priority ?? 0,
    updatedAt: opts.updatedAt ?? '2026-01-01T00:00:00Z',
    description: opts.description === undefined ? null : opts.description,
    url: opts.url ?? `https://linear.app/acme/issue/${opts.identifier}`,
  }
  if (opts.state) issue.state = Promise.resolve(opts.state)
  if (opts.assignee) issue.assignee = Promise.resolve(opts.assignee)
  if (opts.team) issue.team = Promise.resolve(opts.team)
  return issue
}

function sdkConnection(
  nodes: Array<Record<string, unknown>>,
  pageInfo?: Partial<{
    hasNextPage: boolean
    endCursor: string | null
    hasPreviousPage: boolean
    startCursor: string | null
  }>,
): Record<string, unknown> {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
      hasPreviousPage: false,
      startCursor: null,
      ...pageInfo,
    },
  }
}

// -----------------------------------------------------------------------------
// SECTION A: Happy paths — projection + pagination + filters
// -----------------------------------------------------------------------------

describe('issueListRuntime — happy paths', () => {
  it('Test 1: defaults preset projects 8 fields with pageInfo mirrored', async () => {
    setMockIssues(async () =>
      sdkConnection(
        [
          sdkIssue({
            id: 'iss_1',
            identifier: 'ENG-1',
            title: 'first',
            priority: 2,
            updatedAt: '2026-01-01T00:00:00Z',
            state: { name: 'In Progress' },
            assignee: { email: 'alice@example.com' },
            team: { key: 'ENG' },
          }),
          sdkIssue({
            id: 'iss_2',
            identifier: 'ENG-2',
            title: 'second',
            priority: 3,
            updatedAt: '2026-01-02T00:00:00Z',
            state: { name: 'Backlog' },
            assignee: { email: 'bob@example.com' },
            team: { key: 'ENG' },
          }),
        ],
        { hasNextPage: true, endCursor: 'next-page-token' },
      ),
    )

    const out = await issueListRuntime({
      flags: { fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual([
      {
        id: 'iss_1',
        identifier: 'ENG-1',
        title: 'first',
        state: { name: 'In Progress' },
        priority: 2,
        assignee: { email: 'alice@example.com' },
        team: { key: 'ENG' },
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'iss_2',
        identifier: 'ENG-2',
        title: 'second',
        state: { name: 'Backlog' },
        priority: 3,
        assignee: { email: 'bob@example.com' },
        team: { key: 'ENG' },
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('active')
    expect(out.meta.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: 'next-page-token',
      hasPreviousPage: false,
      startCursor: null,
    })
    expect(out).toMatchSnapshot('defaults-2-issues-paginated')
  })

  it('Test 2: --fields=id,title,state.name returns exactly those keys', async () => {
    setMockIssues(async () =>
      sdkConnection([
        sdkIssue({
          id: 'iss_1',
          identifier: 'ENG-1',
          title: 'one',
          state: { name: 'Done' },
        }),
      ]),
    )

    const out = await issueListRuntime({
      flags: { fields: 'id,title,state.name' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual([{ id: 'iss_1', title: 'one', state: { name: 'Done' } }])
    expect(out).toMatchSnapshot('custom-fields-csv')
  })

  it('Test 3: --fields=ids returns only id and identifier', async () => {
    setMockIssues(async () => sdkConnection([sdkIssue({ id: 'iss_1', identifier: 'ENG-1' })]))

    const out = await issueListRuntime({
      flags: { fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual([{ id: 'iss_1', identifier: 'ENG-1' }])
    expect(out).toMatchSnapshot('preset-ids')
  })

  it('Test 4: --fields=full returns the projection passthrough', async () => {
    // Build a small, deterministic shape — no Promise getters since
    // FULL_PRESET passes the value through unchanged.
    setMockIssues(async () =>
      sdkConnection([
        {
          id: 'iss_1',
          identifier: 'ENG-1',
          title: 'full',
          priority: 2,
          updatedAt: '2026-01-01T00:00:00Z',
          description: null,
          url: 'https://linear.app/acme/issue/ENG-1',
        },
      ]),
    )

    const out = await issueListRuntime({
      flags: { fields: 'full' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(Array.isArray(out.data)).toBe(true)
    const arr = out.data as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0]?.identifier).toBe('ENG-1')
    expect(out).toMatchSnapshot('preset-full')
  })

  it('Test 5: empty result returns data: [] and mirrored pageInfo', async () => {
    setMockIssues(async () => sdkConnection([]))

    const out = await issueListRuntime({
      flags: {},
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual([])
    expect(out.meta.pageInfo).toEqual({
      hasNextPage: false,
      endCursor: null,
      hasPreviousPage: false,
      startCursor: null,
    })
    expect(out).toMatchSnapshot('empty-list')
  })

  it('Test 6: --limit + --cursor passes { first, after } to the SDK verbatim', async () => {
    setMockIssues(async () =>
      sdkConnection([sdkIssue({ id: 'iss_1', identifier: 'ENG-1' })], {
        hasNextPage: false,
        endCursor: 'final',
      }),
    )

    const out = await issueListRuntime({
      flags: { limit: 2, cursor: 'abc' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(lastIssuesArgs?.first).toBe(2)
    expect(lastIssuesArgs?.after).toBe('abc')
    expect(out.meta.pageInfo).toMatchSnapshot('paginated-meta')
  })

  it('Test 7: filters --state="In Progress" --assignee=me --team=ENG translate to typed-SDK shape', async () => {
    setMockIssues(async () => sdkConnection([]))

    process.env.LINEAR_WORKSPACE = 'acme'
    await issueListRuntime({
      flags: { state: 'In Progress', assignee: 'me', team: 'ENG' },
      env: { LINEAR_WORKSPACE: 'acme' },
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(lastIssuesArgs?.filter).toEqual({
      state: { name: { eq: 'In Progress' } },
      assignee: { isMe: { eq: true } },
      team: { key: { eq: 'ENG' } },
    })
  })

  it('Test 8: filters with id/email shapes use id and email keys', async () => {
    setMockIssues(async () => sdkConnection([]))

    const stateUuid = '11111111-2222-3333-4444-555555555555'
    const assigneeEmail = 'user@example.com'
    const teamUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    await issueListRuntime({
      flags: { state: stateUuid, assignee: assigneeEmail, team: teamUuid },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(lastIssuesArgs?.filter).toEqual({
      state: { id: { eq: stateUuid } },
      assignee: { email: { eq: assigneeEmail } },
      team: { id: { eq: teamUuid } },
    })
  })
})

// -----------------------------------------------------------------------------
// SECTION B: Failure envelopes — one fixture per error code (KRN-09)
//
// Each test exercises the runtime classifier OR the resolver-level error path,
// then formats the resulting envelope (via failure(...)) and snapshots it.
// -----------------------------------------------------------------------------

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue list' })
}

describe('issueListRuntime — failure envelopes (KRN-09)', () => {
  it('Test 9: WORKSPACE_NOT_RESOLVED (exit 10) — empty config, no env keys', async () => {
    expect.assertions(2)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => EMPTY_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WORKSPACE_NOT_RESOLVED')
    }
  })

  it('Test 10: AUTH_INVALID (exit 11) — SDK throws AuthenticationLinearError', async () => {
    // Phase 2 PLAN 02-01: classifySdkError discriminates on the typed SDK
    // error class via instanceof, NOT message regex.
    setMockIssues(async () => {
      throw new AuthenticationLinearError('Token is invalid (401)')
    })

    expect.assertions(3)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('AUTH_INVALID')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-AUTH_INVALID')
    }
  })

  it('Test 11a: VALIDATION_FAILED via SDK input validation (InvalidInputLinearError)', async () => {
    setMockIssues(async () => {
      throw new InvalidInputLinearError('Argument value is not valid: filter.state.name')
    })

    expect.assertions(3)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-VALIDATION_FAILED-sdk')
    }
  })

  it('Test 11b: INVALID_FIELD (exit 12, validation family) — bad --fields trips parseFields', async () => {
    expect.assertions(2)
    try {
      await issueListRuntime({
        flags: { fields: 'id,bogus' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('INVALID_FIELD')
    }
  })

  it('Test 12: LINEAR_API_ERROR (exit 13) — generic LinearError subclass (InternalLinearError)', async () => {
    setMockIssues(async () => {
      throw new InternalLinearError('GraphQL Error: Unexpected internal server error')
    })

    expect.assertions(3)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-LINEAR_API_ERROR')
    }
  })

  it('Test 13: RATELIMITED (exit 14, transient: true) — RatelimitedLinearError', async () => {
    setMockIssues(async () => {
      throw new RatelimitedLinearError()
    })

    expect.assertions(5)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        // maxAttempts: 1 disables retry so the test surfaces the failure
        // immediately without sleeping.
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RATELIMITED')
      expect(err.transient).toBe(true)
      expect(typeof err.retryAfterMs).toBe('number')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-RATELIMITED')
    }
  })

  it('Test 14: NETWORK_ERROR (exit 15, transient: true) — NetworkLinearError', async () => {
    setMockIssues(async () => {
      throw new NetworkLinearError('fetch failed: ECONNREFUSED 1.2.3.4:443')
    })

    expect.assertions(4)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('NETWORK_ERROR')
      expect(err.transient).toBe(true)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-NETWORK_ERROR')
    }
  })
})

// -----------------------------------------------------------------------------
// SECTION B': Phase 2 PLAN 02-01 Task 3 — transport wiring (RAT-01..03)
// -----------------------------------------------------------------------------

describe('issueListRuntime — transport wiring (Phase 2 PLAN 02-01)', () => {
  it('Phase 2 Task 3 Test 4: RatelimitedLinearError retries 3 attempts; sleep injected so no real wait', async () => {
    let calls = 0
    setMockIssues(async () => {
      calls++
      throw new RatelimitedLinearError()
    })
    const sleep = vi.fn().mockResolvedValue(undefined)

    expect.assertions(3)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        retryOptsOverride: { sleep, random: () => 0 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('RATELIMITED')
      // 3 attempts, 2 sleeps between them
      expect(calls).toBe(3)
    }
  })

  it('Phase 2 Task 3 Test 5: AuthenticationLinearError surfaces immediately with NO retry', async () => {
    let calls = 0
    setMockIssues(async () => {
      calls++
      throw new AuthenticationLinearError('Token rejected')
    })

    expect.assertions(3)
    try {
      await issueListRuntime({
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('AUTH_INVALID')
      expect(calls).toBe(1)
    }
  })
})

// -----------------------------------------------------------------------------
// SECTION C: oclif Command surface
// -----------------------------------------------------------------------------

describe('IssueList oclif command', () => {
  it('Test 15: enableJsonFlag = true and declares the documented flags', () => {
    expect(IssueList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(IssueList.flags)
    for (const expected of [
      'pretty',
      'limit',
      'cursor',
      'workspace',
      'fields',
      'state',
      'assignee',
      'team',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 16: `node bin/run.js issue list --help` exits 0 and mentions --fields', () => {
    // Ensure dist/ is built first; smoke.test.ts already does this in its own
    // beforeAll, but this test is independent.
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
    const out = execFileSync('node', ['bin/run.js', 'issue', 'list', '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/--fields/)
    expect(out).toMatch(/--limit/)
    expect(out).toMatch(/--cursor/)
  })
})
