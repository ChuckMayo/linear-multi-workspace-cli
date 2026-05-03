/**
 * `commentUpdateRuntime` tests (Phase 2 PLAN 02-06 Task 2, CMT-01.update).
 *
 * Coverage:
 *   1. Success -- { body: 'edited' } -> client.updateComment('<uuid>', { body: 'edited' }).
 *   2. VALIDATION_NO_FIELDS -- no --body -> exit 2 BEFORE any SDK call.
 *   3. WSP-06 -- no explicit selector -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call.
 *   4. Empty-string body -- --body '' is forwarded as input.body = '' (Linear arbitrates).
 *   5. payload.success === false -> LINEAR_API_ERROR with details.lastSyncId.
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

import CommentUpdate, { runCommentUpdate } from '@/commands/comment/update.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { commentUpdateRuntime } from '@/lib/comment-update-runtime.js'

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

interface UpdatePayload {
  success: boolean
  lastSyncId: number
  comment?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  updateCommentFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  updateComment?: (id: string, input: Record<string, unknown>) => Promise<UpdatePayload>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const updateCommentFn = vi.fn(async (id: string, input: Record<string, unknown>) => {
    callLog.push({ method: 'updateComment', args: [id, input] })
    if (!opts.updateComment) throw new Error('mock client.updateComment not configured')
    return opts.updateComment(id, input)
  })
  const client = {
    updateComment: updateCommentFn,
  } as unknown as LinearClient
  return { client, updateCommentFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'comment update' })
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

function fakeUpdatedComment(id: string, body: string): Record<string, unknown> {
  return {
    id,
    body,
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:01Z',
    user: Promise.resolve({ email: 'me@example.com', name: 'Me' }),
    issue: Promise.resolve({ identifier: 'ENG-1' }),
    parent: Promise.resolve(undefined),
  }
}

describe('commentUpdateRuntime -- success', () => {
  it('Test 1: --body "edited" -> updateComment(<uuid>, { body: "edited" })', async () => {
    const handle = makeMockClient({
      updateComment: async (id, input) => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(fakeUpdatedComment(id, (input as { body?: string }).body ?? '')),
      }),
    })

    const out = await commentUpdateRuntime({
      args: { id: COMMENT_UUID },
      flags: { workspace: 'acme', body: 'edited' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateCommentFn).toHaveBeenCalledTimes(1)
    const callArgs = handle.updateCommentFn.mock.calls[0]
    expect(callArgs?.[0]).toBe(COMMENT_UUID)
    expect(callArgs?.[1]).toEqual({ body: 'edited' })
    expect(out.meta.workspace).toBe('acme')

    const env = success(out.data, { ...out.meta, command: 'comment update' })
    expect(env).toMatchSnapshot('update-success-body')
  })
})

describe('commentUpdateRuntime -- VALIDATION_NO_FIELDS', () => {
  it('Test 2: no --body -> VALIDATION_NO_FIELDS exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await commentUpdateRuntime({
        args: { id: COMMENT_UUID },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('VALIDATION_NO_FIELDS')
      expect(err.message).toMatch(/--body/)
      expect(factory).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-VALIDATION_NO_FIELDS')
    }
  })
})

describe('commentUpdateRuntime -- WSP-06', () => {
  it('Test 3: no explicit workspace + active default -> WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await commentUpdateRuntime({
        args: { id: COMMENT_UUID },
        flags: { body: 'edited' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      expect(factory).not.toHaveBeenCalled()
      expect(handle.callLog).toHaveLength(0)
    }
  })
})

describe('commentUpdateRuntime -- empty-string body', () => {
  it('Test 4: --body "" -> input.body = "" (forwarded to Linear)', async () => {
    const handle = makeMockClient({
      updateComment: async (id, input) => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(fakeUpdatedComment(id, (input as { body?: string }).body ?? '')),
      }),
    })

    await commentUpdateRuntime({
      args: { id: COMMENT_UUID },
      flags: { workspace: 'acme', body: '' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const callArgs = handle.updateCommentFn.mock.calls[0]
    expect(callArgs?.[1]).toEqual({ body: '' })
  })
})

describe('commentUpdateRuntime -- failure envelopes', () => {
  it('Test 5: payload.success === false -> LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      updateComment: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await commentUpdateRuntime({
        args: { id: COMMENT_UUID },
        flags: { workspace: 'acme', body: 'edited' },
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

describe('CommentUpdate oclif command', () => {
  it('Test 6a: enableJsonFlag = true and declares --body, write-guard flags', () => {
    expect(CommentUpdate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(CommentUpdate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'body',
    ]) {
      expect(flagNames).toContain(expected)
    }
    const args = CommentUpdate.args as Record<string, { required?: boolean }>
    expect(args.id?.required).toBe(true)
  })

  it('Test 6b: runCommentUpdate is exported as a named function', () => {
    expect(typeof runCommentUpdate).toBe('function')
  })
})

describe('commentUpdateRuntime -- no-N+1 guarantee on --fields=ids (CR-01 regression)', () => {
  it('Test 7: --fields=ids does NOT touch the user / issue / parent relation getters on the updated comment', async () => {
    const userAccess = { count: 0 }
    const issueAccess = { count: 0 }
    const parentAccess = { count: 0 }
    const updated: Record<string, unknown> = {
      id: COMMENT_UUID,
      body: 'edited',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:01Z',
    }
    Object.defineProperty(updated, 'user', {
      enumerable: true,
      configurable: true,
      get() {
        userAccess.count++
        return Promise.resolve({ email: 'never-read@example.com' })
      },
    })
    Object.defineProperty(updated, 'issue', {
      enumerable: true,
      configurable: true,
      get() {
        issueAccess.count++
        return Promise.resolve({ identifier: 'NEVER-1' })
      },
    })
    Object.defineProperty(updated, 'parent', {
      enumerable: true,
      configurable: true,
      get() {
        parentAccess.count++
        return Promise.resolve(undefined)
      },
    })

    const handle = makeMockClient({
      updateComment: async () => ({
        success: true,
        lastSyncId: 100,
        comment: Promise.resolve(updated),
      }),
    })

    const out = await commentUpdateRuntime({
      args: { id: COMMENT_UUID },
      flags: { workspace: 'acme', body: 'edited', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(userAccess.count).toBe(0)
    expect(issueAccess.count).toBe(0)
    expect(parentAccess.count).toBe(0)
    expect(out.data).toEqual({ id: COMMENT_UUID })
  })
})
