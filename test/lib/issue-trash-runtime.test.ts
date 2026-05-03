/**
 * `issueTrashRuntime` tests (Phase 2 PLAN 02-05 Task 1, ISS-06.trash).
 *
 * Soft 30-day delete (calls `client.deleteIssue(uuid)` — default
 * permanentlyDelete=false). WSP-06 enforced BEFORE the SDK call. NO `--yes`
 * flag (reversible 30 days — CONTEXT line 49).
 *
 * Coverage:
 *   6. Identifier ENG-1 → resolves to UUID, calls deleteIssue(uuid).
 *   7. WSP-06 — no explicit workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE SDK.
 *   8. oclif command surface — NO `--yes` flag.
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

import IssueTrash, { runIssueTrash } from '@/commands/issue/trash.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { issueTrashRuntime } from '@/lib/issue-trash-runtime.js'

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
  return failure(err, { command: 'issue trash' })
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

describe('issueTrashRuntime — happy path', () => {
  it('Test 6: identifier ENG-1 → resolves UUID, calls deleteIssue(uuid) with NO permanentlyDelete:true', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID, identifier: 'ENG-1' }] }),
      deleteIssue: async () => ({ success: true, lastSyncId: 1 }),
    })

    const out = await issueTrashRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.deleteIssueFn).toHaveBeenCalledTimes(1)
    const call = handle.deleteIssueFn.mock.calls[0] as [string, unknown?]
    expect(call[0]).toBe(ISSUE_UUID)
    // Soft delete -- must NOT pass permanentlyDelete:true. Either no second
    // arg or `{ permanentlyDelete: false }` (we accept both shapes).
    if (call[1] !== undefined) {
      expect(call[1]).not.toMatchObject({ permanentlyDelete: true })
    }
    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1', trashed: true })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(out).toMatchSnapshot('trash-success')
  })
})

describe('issueTrashRuntime — WSP-06 enforcement', () => {
  it('Test 7: no explicit workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await issueTrashRuntime({
        args: { identifier: 'ENG-1' },
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
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WORKSPACE_REQUIRED_FOR_WRITE')
    }
  })
})

describe('IssueTrash oclif command', () => {
  it('Test 8: enableJsonFlag, args.identifier required, NO --yes flag', () => {
    expect(IssueTrash.enableJsonFlag).toBe(true)
    const args = IssueTrash.args as Record<string, { required?: boolean }>
    expect(args.identifier?.required).toBe(true)
    const flagNames = Object.keys(IssueTrash.flags)
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(flagNames).not.toContain('yes')
    expect(typeof runIssueTrash).toBe('function')
  })
})
