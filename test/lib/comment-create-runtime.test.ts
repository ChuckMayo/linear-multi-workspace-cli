/**
 * `commentCreateRuntime` tests (Phase 2 PLAN 02-06 Task 1, CMT-01.create).
 *
 * Coverage:
 *   1. ENG-1 + body -> client.createComment({ body, issueId: 'ENG-1' }) directly.
 *      Per RESEARCH 02-06 line 887, CommentCreateInput accepts the identifier.
 *   2. --parent <uuid> -> input.parentId = <uuid>.
 *   3. WSP-06 -- no explicit selector + active workspace -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call.
 *   4. Missing --body -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   5. Missing --issue -> USAGE_ERROR exit 2 BEFORE any SDK call.
 *   6. payload.success === false -> LINEAR_API_ERROR with details.lastSyncId.
 *   7. Returns the created comment, projected per --fields.
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

import CommentCreate, { runCommentCreate } from '@/commands/comment/create.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { commentCreateRuntime } from '@/lib/comment-create-runtime.js'

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

const COMMENT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PARENT_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

interface CreatePayload {
  success: boolean
  lastSyncId: number
  comment?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  createCommentFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  createComment?: (input: Record<string, unknown>) => Promise<CreatePayload>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const createCommentFn = vi.fn(async (input: Record<string, unknown>) => {
    callLog.push({ method: 'createComment', args: [input] })
    if (!opts.createComment) throw new Error('mock client.createComment not configured')
    return opts.createComment(input)
  })
  const client = {
    createComment: createCommentFn,
  } as unknown as LinearClient
  return { client, createCommentFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'comment create' })
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

function fakeCreatedComment(id: string): Record<string, unknown> {
  return {
    id,
    body: 'looks good',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    user: Promise.resolve({ email: 'me@example.com', name: 'Me' }),
    issue: Promise.resolve({ identifier: 'ENG-1' }),
    parent: Promise.resolve(undefined),
  }
}

describe('commentCreateRuntime -- ENG-N identifier passthrough', () => {
  it('Test 1: --issue ENG-1 + --body -> createComment({ body, issueId: "ENG-1" })', async () => {
    const handle = makeMockClient({
      createComment: async (_input) => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(fakeCreatedComment(COMMENT_UUID)),
      }),
    })

    const out = await commentCreateRuntime({
      args: {},
      flags: { workspace: 'acme', issue: 'ENG-1', body: 'looks good' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.createCommentFn).toHaveBeenCalledTimes(1)
    const callInput = handle.createCommentFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({ body: 'looks good', issueId: 'ENG-1' })
    expect(Object.keys(callInput).length).toBe(2)
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')

    const env = success(out.data, { ...out.meta, command: 'comment create' })
    expect(env).toMatchSnapshot('create-success-eng-passthrough')
  })
})

describe('commentCreateRuntime -- parent', () => {
  it('Test 2: --parent <uuid> -> input.parentId = <uuid>', async () => {
    const handle = makeMockClient({
      createComment: async (_input) => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(fakeCreatedComment(COMMENT_UUID)),
      }),
    })

    await commentCreateRuntime({
      args: {},
      flags: {
        workspace: 'acme',
        issue: 'ENG-1',
        body: 'reply',
        parent: PARENT_UUID,
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const callInput = handle.createCommentFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({
      body: 'reply',
      issueId: 'ENG-1',
      parentId: PARENT_UUID,
    })
  })
})

describe('commentCreateRuntime -- WSP-06', () => {
  it('Test 3: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await commentCreateRuntime({
        args: {},
        flags: { issue: 'ENG-1', body: 'hello' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      // Factory is built AFTER WSP-06 -- guard runs before client is created.
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WSP-06-write-guard')
    }
  })
})

describe('commentCreateRuntime -- USAGE_ERROR (missing flags)', () => {
  it('Test 4: missing --body -> USAGE_ERROR BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await commentCreateRuntime({
        args: {},
        flags: { workspace: 'acme', issue: 'ENG-1' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--body is required/)
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
    }
  })

  it('Test 5: missing --issue -> USAGE_ERROR BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await commentCreateRuntime({
        args: {},
        flags: { workspace: 'acme', body: 'hello' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(err.message).toMatch(/--issue is required/)
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
    }
  })
})

describe('commentCreateRuntime -- payload failure', () => {
  it('Test 6: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      createComment: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await commentCreateRuntime({
        args: {},
        flags: { workspace: 'acme', issue: 'ENG-1', body: 'hi' },
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

describe('commentCreateRuntime -- projection', () => {
  it('Test 7: created comment is projected per --fields', async () => {
    const handle = makeMockClient({
      createComment: async () => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(fakeCreatedComment(COMMENT_UUID)),
      }),
    })

    const out = await commentCreateRuntime({
      args: {},
      flags: { workspace: 'acme', issue: 'ENG-1', body: 'hi', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual({ id: COMMENT_UUID })
  })
})

describe('CommentCreate oclif command', () => {
  it('Test 8a: enableJsonFlag = true and declares --issue, --body, --parent, write-guard flags', () => {
    expect(CommentCreate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CommentCreate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'issue',
      'body',
      'parent',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 8b: runCommentCreate is exported as a named function', () => {
    expect(typeof runCommentCreate).toBe('function')
  })
})
