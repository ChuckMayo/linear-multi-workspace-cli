/**
 * `commentListRuntime` tests (Phase 2 PLAN 02-06 Task 1, CMT-01.list).
 *
 * Coverage:
 *   1. Workspace-wide list -- no --issue: client.comments({ first: 25 }) (no filter).
 *   2. --issue ENG-1 -- resolves to UUID via client.issues filter, then
 *      client.comments({ first: 25, filter: { issue: { id: { eq: <uuid> } } } }).
 *   3. --issue <uuid> -- UUID passthrough; NO client.issues lookup.
 *   4. --limit 10 --cursor token -> { first: 10, after: 'token' }.
 *   5. meta.pageInfo populated from connection.pageInfo.
 *   6. Empty connection -> data: [].
 *   7. Lazy hydration -- defaults preset awaits user, issue, parent on each
 *      comment node.
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

import CommentList, { runCommentList } from '@/commands/comment/list.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { commentListRuntime } from '@/lib/comment-list-runtime.js'

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
const COMMENT_UUID_1 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const COMMENT_UUID_2 = 'cccccccc-dddd-eeee-ffff-000011112222'

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
  commentsFn: ReturnType<typeof vi.fn>
  issuesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  comments?: (args: unknown) => Promise<SdkConnection>
  issues?: (args: unknown) => Promise<{ nodes: Array<{ id: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const commentsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'comments', args: [args] })
    if (!opts.comments) throw new Error('mock client.comments not configured')
    return opts.comments(args)
  })
  const issuesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'issues', args: [args] })
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const client = {
    comments: commentsFn,
    issues: issuesFn,
  } as unknown as LinearClient
  return { client, commentsFn, issuesFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'comment list' })
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

function fakeComment(id: string): Record<string, unknown> {
  return {
    id,
    body: 'looks good',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    user: Promise.resolve({ email: 'alice@example.com', name: 'Alice' }),
    issue: Promise.resolve({ identifier: 'ENG-1' }),
    parent: Promise.resolve(undefined),
  }
}

describe('commentListRuntime -- workspace-wide', () => {
  it('Test 1: no --issue -> client.comments({ first: 25 }) with no filter', async () => {
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [fakeComment(COMMENT_UUID_1)],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        },
      }),
    })

    const out = await commentListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.commentsFn).toHaveBeenCalledTimes(1)
    expect(handle.issuesFn).not.toHaveBeenCalled()
    const args = handle.commentsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(25)
    expect(args.filter).toBeUndefined()
    expect(args.after).toBeUndefined()
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(Array.isArray(out.data)).toBe(true)
    expect((out.data as unknown[]).length).toBe(1)

    const env = success(out.data, { ...out.meta, command: 'comment list' })
    expect(env).toMatchSnapshot('list-success-workspace-wide')
  })
})

describe('commentListRuntime -- issue-scoped (identifier)', () => {
  it('Test 2: --issue ENG-1 -> resolves via client.issues filter, then comments filter applied', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID }] }),
      comments: async () => ({
        nodes: [fakeComment(COMMENT_UUID_1)],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await commentListRuntime({
      flags: { workspace: 'acme', issue: 'ENG-1' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).toHaveBeenCalledTimes(1)
    const issuesArgs = handle.issuesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(issuesArgs).toEqual({
      filter: { team: { key: { eq: 'ENG' } }, number: { eq: 1 } },
      first: 1,
    })

    expect(handle.commentsFn).toHaveBeenCalledTimes(1)
    const commentsArgs = handle.commentsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(commentsArgs.first).toBe(25)
    expect(commentsArgs.filter).toEqual({ issue: { id: { eq: ISSUE_UUID } } })
  })
})

describe('commentListRuntime -- issue-scoped (UUID passthrough)', () => {
  it('Test 3: --issue <uuid> -> NO client.issues lookup, comments filter still applied', async () => {
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [fakeComment(COMMENT_UUID_1)],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await commentListRuntime({
      flags: { workspace: 'acme', issue: ISSUE_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // Fast path: no issues lookup.
    expect(handle.issuesFn).not.toHaveBeenCalled()
    const commentsArgs = handle.commentsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(commentsArgs.filter).toEqual({ issue: { id: { eq: ISSUE_UUID } } })
  })
})

describe('commentListRuntime -- pagination', () => {
  it('Test 4: --limit 10 --cursor token -> { first: 10, after: "token" }', async () => {
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    await commentListRuntime({
      flags: { workspace: 'acme', limit: 10, cursor: 'opaque-token-abc' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const args = handle.commentsFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.first).toBe(10)
    expect(args.after).toBe('opaque-token-abc')
  })
})

describe('commentListRuntime -- pageInfo + empty', () => {
  it('Test 5: meta.pageInfo populated from connection.pageInfo', async () => {
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [fakeComment(COMMENT_UUID_1)],
        pageInfo: {
          hasNextPage: true,
          endCursor: 'next-page',
          hasPreviousPage: false,
          startCursor: 'first',
        },
      }),
    })

    const out = await commentListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.meta.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: 'next-page',
      hasPreviousPage: false,
      startCursor: 'first',
    })
  })

  it('Test 6: empty list -> data: []', async () => {
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await commentListRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual([])
  })
})

describe('commentListRuntime -- lazy hydration on defaults preset', () => {
  it('Test 7: --fields=defaults awaits user / issue / parent on each node', async () => {
    // Spy on each lazy promise so we can verify it was awaited.
    const userSpy = vi.fn(() => ({ email: 'a@example.com', name: 'A' }))
    const issueSpy = vi.fn(() => ({ identifier: 'ENG-1' }))
    const parentSpy = vi.fn(() => undefined)
    const node: Record<string, unknown> = {
      id: COMMENT_UUID_2,
      body: 'hi',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      user: Promise.resolve().then(() => userSpy()),
      issue: Promise.resolve().then(() => issueSpy()),
      parent: Promise.resolve().then(() => parentSpy()),
    }
    const handle = makeMockClient({
      comments: async () => ({
        nodes: [node],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await commentListRuntime({
      flags: { workspace: 'acme', fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(userSpy).toHaveBeenCalledTimes(1)
    expect(issueSpy).toHaveBeenCalledTimes(1)
    expect(parentSpy).toHaveBeenCalledTimes(1)
    const projected = (out.data as Array<Record<string, unknown>>)[0]
    expect(projected).toBeDefined()
    expect((projected as Record<string, unknown>).id).toBe(COMMENT_UUID_2)
    // Default preset includes user.email and issue.identifier
    expect((projected as Record<string, Record<string, unknown>>).user?.email).toBe('a@example.com')
    expect((projected as Record<string, Record<string, unknown>>).issue?.identifier).toBe('ENG-1')
  })
})

describe('commentListRuntime -- ISSUE_NOT_FOUND', () => {
  it('Test 8: --issue ENG-99 with no matching node -> ISSUE_NOT_FOUND', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await commentListRuntime({
        flags: { workspace: 'acme', issue: 'ENG-99' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(err.details).toMatchObject({ ref: 'ENG-99' })
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-ISSUE_NOT_FOUND')
    }
  })
})

describe('CommentList oclif command', () => {
  it('Test 9a: enableJsonFlag = true and declares --issue, --limit, --cursor, --fields, --workspace', () => {
    expect(CommentList.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CommentList.flags)
    for (const expected of ['pretty', 'workspace', 'fields', 'limit', 'cursor', 'issue']) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 9b: runCommentList is exported as a named function', () => {
    expect(typeof runCommentList).toBe('function')
  })
})

describe('commentListRuntime -- no-N+1 guarantee on --fields=ids (CR-01 regression)', () => {
  it('Test 10: --fields=ids does NOT touch the user / issue / parent relation getters', async () => {
    // Spy counters mirror the issue-get-runtime Test 7b pattern: define
    // each relation as an enumerable getter so a spread enumeration would
    // fire it. The runtime MUST avoid that path on --fields=ids.
    const userAccess = { count: 0 }
    const issueAccess = { count: 0 }
    const parentAccess = { count: 0 }
    const node: Record<string, unknown> = {
      id: COMMENT_UUID_1,
      body: 'no relations needed',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    }
    Object.defineProperty(node, 'user', {
      enumerable: true,
      configurable: true,
      get() {
        userAccess.count++
        return Promise.resolve({ email: 'never-read@example.com' })
      },
    })
    Object.defineProperty(node, 'issue', {
      enumerable: true,
      configurable: true,
      get() {
        issueAccess.count++
        return Promise.resolve({ identifier: 'NEVER-1' })
      },
    })
    Object.defineProperty(node, 'parent', {
      enumerable: true,
      configurable: true,
      get() {
        parentAccess.count++
        return Promise.resolve(undefined)
      },
    })

    const handle = makeMockClient({
      comments: async () => ({
        nodes: [node],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    })

    const out = await commentListRuntime({
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(userAccess.count).toBe(0)
    expect(issueAccess.count).toBe(0)
    expect(parentAccess.count).toBe(0)
    expect((out.data as Array<Record<string, unknown>>)[0]).toEqual({ id: COMMENT_UUID_1 })
  })
})
