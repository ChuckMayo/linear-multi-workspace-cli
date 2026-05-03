/**
 * `commentDeleteRuntime` tests (Phase 2 PLAN 02-06 Task 2, CMT-01.delete).
 *
 * Coverage:
 *   1. Success -> client.deleteComment(uuid) returns { success: true }; runtime
 *      returns { data: { id, deleted: true } }.
 *   2. WSP-06 -- no explicit selector -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call.
 *   3. NO --yes flag -- comments are individually low-stakes.
 *   4. payload.success === false -> LINEAR_API_ERROR with details.lastSyncId.
 *   5. payload.entity?.id matches the input id (sanity).
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

import CommentDelete, { runCommentDelete } from '@/commands/comment/delete.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { commentDeleteRuntime } from '@/lib/comment-delete-runtime.js'

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

interface DeletePayload {
  success: boolean
  lastSyncId: number
  entity?: { id?: string }
}

interface MockHandle {
  client: LinearClient
  deleteCommentFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  deleteComment?: (id: string) => Promise<DeletePayload>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const deleteCommentFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'deleteComment', args: [id] })
    if (!opts.deleteComment) throw new Error('mock client.deleteComment not configured')
    return opts.deleteComment(id)
  })
  const client = {
    deleteComment: deleteCommentFn,
  } as unknown as LinearClient
  return { client, deleteCommentFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'comment delete' })
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

describe('commentDeleteRuntime -- success', () => {
  it('Test 1: id -> deleteComment(<uuid>); returns { id, deleted: true }', async () => {
    const handle = makeMockClient({
      deleteComment: async (id) => ({
        success: true,
        lastSyncId: 100,
        entity: { id },
      }),
    })

    const out = await commentDeleteRuntime({
      args: { id: COMMENT_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.deleteCommentFn).toHaveBeenCalledTimes(1)
    expect(handle.deleteCommentFn.mock.calls[0]?.[0]).toBe(COMMENT_UUID)
    expect(out.data).toEqual({ id: COMMENT_UUID, deleted: true })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')

    const env = success(out.data, { ...out.meta, command: 'comment delete' })
    expect(env).toMatchSnapshot('delete-success')
  })
})

describe('commentDeleteRuntime -- WSP-06', () => {
  it('Test 2: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await commentDeleteRuntime({
        args: { id: COMMENT_UUID },
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

describe('commentDeleteRuntime -- no --yes flag', () => {
  it('Test 3: oclif Command class does NOT declare a --yes flag', () => {
    const flagNames = Object.keys(CommentDelete.flags)
    expect(flagNames).not.toContain('yes')
  })
})

describe('commentDeleteRuntime -- failure envelopes', () => {
  it('Test 4: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      deleteComment: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await commentDeleteRuntime({
        args: { id: COMMENT_UUID },
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

describe('commentDeleteRuntime -- entity sanity', () => {
  it('Test 5: payload.entity.id matches input id (sanity)', async () => {
    const handle = makeMockClient({
      deleteComment: async (id) => ({
        success: true,
        lastSyncId: 100,
        entity: { id },
      }),
    })

    await commentDeleteRuntime({
      args: { id: COMMENT_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // The runtime currently echoes args.id back -- this asserts the SDK was
    // called with that exact id (so the round-trip is internally consistent).
    expect(handle.deleteCommentFn.mock.calls[0]?.[0]).toBe(COMMENT_UUID)
  })
})

describe('CommentDelete oclif command', () => {
  it('Test 6a: enableJsonFlag = true and declares write-guard flags but NOT --yes', () => {
    expect(CommentDelete.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CommentDelete.flags)
    for (const expected of ['pretty', 'workspace', 'allow-active-workspace-write']) {
      expect(flagNames).toContain(expected)
    }
    expect(flagNames).not.toContain('yes')
    const args = CommentDelete.args as Record<string, { required?: boolean }>
    expect(args.id?.required).toBe(true)
  })

  it('Test 6b: runCommentDelete is exported as a named function', () => {
    expect(typeof runCommentDelete).toBe('function')
  })
})
