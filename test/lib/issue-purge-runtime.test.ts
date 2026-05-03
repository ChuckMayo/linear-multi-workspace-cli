/**
 * `issuePurgeRuntime` tests (Phase 2 PLAN 02-05 Task 1, ISS-06.purge).
 *
 * Permanent delete (calls `client.deleteIssue(uuid, { permanentlyDelete:
 * true })`) gated on `--yes`. Without `--yes`, throws `CONFIRMATION_REQUIRED`
 * (exit 2) BEFORE any SDK call. WSP-06 fires FIRST (before the
 * confirmation gate).
 *
 * Coverage:
 *   9.  --yes:false (or unset) → CONFIRMATION_REQUIRED; SDK calls = 0.
 *   10. --yes:true → deleteIssue(uuid, { permanentlyDelete: true }) (exact shape).
 *   11. WSP-06 ordering — no explicit workspace + --yes:true still throws
 *       WORKSPACE_REQUIRED_FOR_WRITE BEFORE the CONFIRMATION_REQUIRED check.
 *   12. oclif command surface — --yes flag exists.
 *   13. Success envelope has data.permanentlyDeleted: true.
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

import IssuePurge, { runIssuePurge } from '@/commands/issue/purge.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { issuePurgeRuntime } from '@/lib/issue-purge-runtime.js'

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

interface DeletePayload {
  success: boolean
  lastSyncId: number
  entity?: Record<string, unknown>
}

interface MockHandle {
  client: LinearClient
  issuesFn: ReturnType<typeof vi.fn>
  issueFn: ReturnType<typeof vi.fn>
  deleteIssueFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issues?: (args: unknown) => Promise<{ nodes: Array<Record<string, unknown>> }>
  issue?: (id: string) => Promise<unknown>
  deleteIssue?: (id: string, opts?: { permanentlyDelete?: boolean }) => Promise<DeletePayload>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const issuesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'issues', args: [args] })
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const issueFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'issue', args: [id] })
    if (!opts.issue) throw new Error('mock client.issue not configured')
    return opts.issue(id)
  })
  const deleteIssueFn = vi.fn(async (id: string, deleteOpts?: { permanentlyDelete?: boolean }) => {
    callLog.push({ method: 'deleteIssue', args: [id, deleteOpts] })
    if (!opts.deleteIssue) throw new Error('mock client.deleteIssue not configured')
    return opts.deleteIssue(id, deleteOpts)
  })
  const client = {
    issues: issuesFn,
    issue: issueFn,
    deleteIssue: deleteIssueFn,
  } as unknown as LinearClient
  return { client, issuesFn, issueFn, deleteIssueFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue purge' })
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

describe('issuePurgeRuntime — CONFIRMATION_REQUIRED gate', () => {
  it('Test 9: --yes false (default) → CONFIRMATION_REQUIRED BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await issuePurgeRuntime({
        args: { identifier: 'ENG-1' },
        flags: { workspace: 'acme', yes: false },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('CONFIRMATION_REQUIRED')
      expect(err.message).toMatch(/purge is permanent/)
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-CONFIRMATION_REQUIRED')
    }
  })
})

describe('issuePurgeRuntime — happy path with --yes', () => {
  it('Test 10: --yes true → deleteIssue(uuid, { permanentlyDelete: true }) exact shape', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID, identifier: 'ENG-1' }] }),
      deleteIssue: async () => ({ success: true, lastSyncId: 1 }),
    })

    const out = await issuePurgeRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', yes: true },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.deleteIssueFn).toHaveBeenCalledTimes(1)
    const call = handle.deleteIssueFn.mock.calls[0] as [string, { permanentlyDelete?: boolean }]
    expect(call[0]).toBe(ISSUE_UUID)
    // Exact-shape: second arg has `permanentlyDelete: true` and only that key.
    expect(call[1]).toEqual({ permanentlyDelete: true })
    expect(Object.keys(call[1] as object)).toEqual(['permanentlyDelete'])
    expect(out.meta.workspace).toBe('acme')
  })
})

describe('issuePurgeRuntime — WSP-06 ordering', () => {
  it('Test 11: WSP-06 fires BEFORE CONFIRMATION_REQUIRED (no explicit workspace + --yes:true → WORKSPACE_REQUIRED_FOR_WRITE)', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await issuePurgeRuntime({
        args: { identifier: 'ENG-1' },
        flags: { yes: true },
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
    }
  })
})

describe('IssuePurge oclif command', () => {
  it('Test 12: --yes flag exists; default false', () => {
    expect(IssuePurge.enableJsonFlag).toBe(true)
    const args = IssuePurge.args as Record<string, { required?: boolean }>
    expect(args.identifier?.required).toBe(true)
    const flagNames = Object.keys(IssuePurge.flags)
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(flagNames).toContain('yes')
    expect(typeof runIssuePurge).toBe('function')
  })
})

describe('issuePurgeRuntime — success envelope shape', () => {
  it('Test 13: data has permanentlyDeleted: true', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID, identifier: 'ENG-1' }] }),
      deleteIssue: async () => ({ success: true, lastSyncId: 1 }),
    })

    const out = await issuePurgeRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', yes: true },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1', permanentlyDeleted: true })
    expect(out).toMatchSnapshot('purge-success')
  })
})
