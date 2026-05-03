/**
 * `issueGetRuntime` tests (Phase 2 PLAN 02-03 Task 1, ISS-02).
 *
 * Mirrors the Phase 1 `issue list` mock pattern: vi.mock('@linear/sdk') at the
 * top so the transport's `instanceof RatelimitedLinearError` resolves to the
 * SAME class identity tests `new` and throw. Tests target the named runtime
 * (`issueGetRuntime`) directly via `clientFactoryOverride` — no subprocess.
 *
 * Coverage:
 *   1.  UUID input → client.issue(uuid) once.
 *   2.  Identifier input "ENG-123" → client.issues({ filter: team.key + number }, first: 1).
 *   3.  Lowercase identifier "eng-123" upper-cases the key.
 *   4.  Multi-segment key "ABC1-42".
 *   5.  Identifier with empty result → ISSUE_NOT_FOUND with details.ref.
 *   6.  UUID with no Issue returned → ISSUE_NOT_FOUND with details.ref.
 *   7.  Lazy hydration on --fields=defaults; no hydration on --fields=ids.
 *   8.  --fields=full passthrough.
 *   9.  Rate-limit propagates as classified RATELIMITED (exit 14, transient: true).
 *   10. oclif Command surface: enableJsonFlag, args.identifier, flags, named runIssueGet.
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
import { RatelimitedLinearError as RealRatelimitedLinearError } from '@linear/sdk'

import IssueGet, { runIssueGet } from '@/commands/issue/get.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { issueGetRuntime } from '@/lib/issue-get-runtime.js'

const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (opts?: {
  message?: string
  retryAfter?: number
}) => Error

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

const ISSUE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

interface IssueShape {
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

interface SdkIssueWithSpies extends Record<string, unknown> {
  __stateAccess: { count: number }
  __assigneeAccess: { count: number }
  __teamAccess: { count: number }
}

function sdkIssue(opts: IssueShape): SdkIssueWithSpies {
  const stateAccess = { count: 0 }
  const assigneeAccess = { count: 0 }
  const teamAccess = { count: 0 }
  const issue: Record<string, unknown> = {
    id: opts.id,
    identifier: opts.identifier,
    title: opts.title ?? `title-${opts.identifier}`,
    priority: opts.priority ?? 0,
    updatedAt: opts.updatedAt ?? '2026-01-01T00:00:00Z',
    description: opts.description === undefined ? null : opts.description,
    url: opts.url ?? `https://linear.app/acme/issue/${opts.identifier}`,
  }
  // Spy on relation getters so Test 7 can assert they're never read on --fields=ids.
  Object.defineProperty(issue, 'state', {
    enumerable: true,
    configurable: true,
    get() {
      stateAccess.count++
      return opts.state ? Promise.resolve(opts.state) : undefined
    },
  })
  Object.defineProperty(issue, 'assignee', {
    enumerable: true,
    configurable: true,
    get() {
      assigneeAccess.count++
      return opts.assignee ? Promise.resolve(opts.assignee) : undefined
    },
  })
  Object.defineProperty(issue, 'team', {
    enumerable: true,
    configurable: true,
    get() {
      teamAccess.count++
      return opts.team ? Promise.resolve(opts.team) : undefined
    },
  })
  ;(issue as SdkIssueWithSpies).__stateAccess = stateAccess
  ;(issue as SdkIssueWithSpies).__assigneeAccess = assigneeAccess
  ;(issue as SdkIssueWithSpies).__teamAccess = teamAccess
  return issue as SdkIssueWithSpies
}

interface IssuesArgs {
  first?: number
  filter?: unknown
}

interface MockClientHandle {
  client: LinearClient
  issuesFn: ReturnType<typeof vi.fn>
  issueFn: ReturnType<typeof vi.fn>
  lastIssuesArgs: { current: IssuesArgs | null }
  lastIssueArg: { current: string | null }
}

function makeMockClient(opts: {
  issues?: (args: IssuesArgs) => Promise<unknown>
  issue?: (id: string) => Promise<unknown>
}): MockClientHandle {
  const lastIssuesArgs = { current: null as IssuesArgs | null }
  const lastIssueArg = { current: null as string | null }
  const issuesFn = vi.fn(async (args: IssuesArgs) => {
    lastIssuesArgs.current = args
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const issueFn = vi.fn(async (id: string) => {
    lastIssueArg.current = id
    if (!opts.issue) throw new Error('mock client.issue not configured')
    return opts.issue(id)
  })
  const client = { issues: issuesFn, issue: issueFn } as unknown as LinearClient
  return { client, issuesFn, issueFn, lastIssuesArgs, lastIssueArg }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue get' })
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

describe('issueGetRuntime — identifier vs UUID resolution', () => {
  it('Test 1: UUID input routes to client.issue(uuid) exactly once', async () => {
    const handle = makeMockClient({
      issue: async () =>
        sdkIssue({
          id: ISSUE_UUID,
          identifier: 'ENG-1',
          title: 'first',
          state: { name: 'In Progress' },
          assignee: { email: 'alice@example.com' },
          team: { key: 'ENG' },
        }),
    })

    const out = await issueGetRuntime({
      args: { identifier: ISSUE_UUID },
      flags: {},
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issueFn).toHaveBeenCalledTimes(1)
    expect(handle.issuesFn).not.toHaveBeenCalled()
    expect(handle.lastIssueArg.current).toBe(ISSUE_UUID)
    expect(out.data).toEqual({
      id: ISSUE_UUID,
      identifier: 'ENG-1',
      title: 'first',
      state: { name: 'In Progress' },
      priority: 0,
      assignee: { email: 'alice@example.com' },
      team: { key: 'ENG' },
      updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('active')
    expect(out).toMatchSnapshot('uuid-success')
  })

  it('Test 2: identifier input "ENG-123" routes via client.issues with team.key + number filter', async () => {
    const handle = makeMockClient({
      issues: async () => ({
        nodes: [
          sdkIssue({
            id: ISSUE_UUID,
            identifier: 'ENG-123',
            title: 'by-identifier',
            state: { name: 'Todo' },
            assignee: { email: 'bob@example.com' },
            team: { key: 'ENG' },
          }),
        ],
      }),
    })

    const out = await issueGetRuntime({
      args: { identifier: 'ENG-123' },
      flags: {},
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).toHaveBeenCalledTimes(1)
    expect(handle.issueFn).not.toHaveBeenCalled()
    expect(handle.lastIssuesArgs.current).toEqual({
      filter: { team: { key: { eq: 'ENG' } }, number: { eq: 123 } },
      first: 1,
    })
    expect(out.data).toMatchObject({ id: ISSUE_UUID, identifier: 'ENG-123' })
  })

  it('Test 3: identifier input "eng-123" is uppercased to ENG', async () => {
    const handle = makeMockClient({
      issues: async () => ({
        nodes: [sdkIssue({ id: ISSUE_UUID, identifier: 'ENG-123' })],
      }),
    })

    await issueGetRuntime({
      args: { identifier: 'eng-123' },
      flags: { fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.lastIssuesArgs.current).toEqual({
      filter: { team: { key: { eq: 'ENG' } }, number: { eq: 123 } },
      first: 1,
    })
  })

  it('Test 4: multi-segment key "ABC1-42" routes with key=ABC1, number=42', async () => {
    const handle = makeMockClient({
      issues: async () => ({
        nodes: [sdkIssue({ id: ISSUE_UUID, identifier: 'ABC1-42' })],
      }),
    })

    await issueGetRuntime({
      args: { identifier: 'ABC1-42' },
      flags: { fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.lastIssuesArgs.current).toEqual({
      filter: { team: { key: { eq: 'ABC1' } }, number: { eq: 42 } },
      first: 1,
    })
  })

  it('Test 5: identifier with empty result throws ISSUE_NOT_FOUND with details.ref', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [] }),
    })

    expect.assertions(5)
    try {
      await issueGetRuntime({
        args: { identifier: 'ENG-999' },
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(err.message).toMatch(/issue not found: ENG-999/)
      expect(err.details).toEqual({ ref: 'ENG-999' })
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-ISSUE_NOT_FOUND-identifier')
    }
  })

  it('Test 6: UUID returning undefined/null throws ISSUE_NOT_FOUND with details.ref=<uuid>', async () => {
    const handle = makeMockClient({
      issue: async () => undefined,
    })

    expect.assertions(3)
    try {
      await issueGetRuntime({
        args: { identifier: ISSUE_UUID },
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(err.details).toEqual({ ref: ISSUE_UUID })
    }
  })
})

describe('issueGetRuntime — projection + hydration', () => {
  it('Test 7a: --fields=defaults awaits state.name, assignee.email, team.key relations', async () => {
    const issue = sdkIssue({
      id: ISSUE_UUID,
      identifier: 'ENG-1',
      title: 'hydrated',
      state: { name: 'In Progress' },
      assignee: { email: 'alice@example.com' },
      team: { key: 'ENG' },
    })
    const handle = makeMockClient({ issue: async () => issue })

    const out = await issueGetRuntime({
      args: { identifier: ISSUE_UUID },
      flags: { fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(issue.__stateAccess.count).toBeGreaterThan(0)
    expect(issue.__assigneeAccess.count).toBeGreaterThan(0)
    expect(issue.__teamAccess.count).toBeGreaterThan(0)
    expect(out.data).toMatchObject({
      state: { name: 'In Progress' },
      assignee: { email: 'alice@example.com' },
      team: { key: 'ENG' },
    })
  })

  it('Test 7b: --fields=ids does NOT touch the relation getters', async () => {
    const issue = sdkIssue({
      id: ISSUE_UUID,
      identifier: 'ENG-1',
      state: { name: 'In Progress' },
      assignee: { email: 'alice@example.com' },
      team: { key: 'ENG' },
    })
    const handle = makeMockClient({ issue: async () => issue })

    const out = await issueGetRuntime({
      args: { identifier: ISSUE_UUID },
      flags: { fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(issue.__stateAccess.count).toBe(0)
    expect(issue.__assigneeAccess.count).toBe(0)
    expect(issue.__teamAccess.count).toBe(0)
    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1' })
  })

  it('Test 8: --fields=full returns the issue passthrough', async () => {
    const handle = makeMockClient({
      issue: async () => ({
        id: ISSUE_UUID,
        identifier: 'ENG-1',
        title: 'full',
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
        description: null,
        url: 'https://linear.app/acme/issue/ENG-1',
      }),
    })

    const out = await issueGetRuntime({
      args: { identifier: ISSUE_UUID },
      flags: { fields: 'full' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const data = out.data as Record<string, unknown>
    expect(data.identifier).toBe('ENG-1')
    expect(data.title).toBe('full')
    expect(out).toMatchSnapshot('full-passthrough')
  })
})

describe('issueGetRuntime — failure envelopes', () => {
  it('Test 9: rate-limit propagation surfaces as RATELIMITED (exit 14, transient: true)', async () => {
    const handle = makeMockClient({
      issue: async () => {
        throw new RatelimitedLinearError()
      },
    })

    expect.assertions(4)
    try {
      await issueGetRuntime({
        args: { identifier: ISSUE_UUID },
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
        retryOptsOverride: { maxAttempts: 1 },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RATELIMITED')
      expect(err.transient).toBe(true)
      expect(typeof err.retryAfterMs).toBe('number')
    }
  })
})

describe('IssueGet oclif command', () => {
  it('Test 10a: enableJsonFlag = true and declares args + flags', () => {
    expect(IssueGet.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(IssueGet.flags)
    for (const expected of ['pretty', 'workspace', 'fields']) {
      expect(flagNames).toContain(expected)
    }
    const args = IssueGet.args
    expect(args).toBeDefined()
    expect((args as Record<string, { required?: boolean }>).identifier?.required).toBe(true)
  })

  it('Test 10b: runIssueGet is exported as a named function', () => {
    expect(typeof runIssueGet).toBe('function')
  })
})
