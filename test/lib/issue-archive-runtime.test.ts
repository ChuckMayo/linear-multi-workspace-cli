/**
 * `issueArchiveRuntime` tests (Phase 2 PLAN 02-05 Task 1, ISS-06.archive).
 *
 * Reversible archive (calls `client.archiveIssue(uuid)`). WSP-06 enforced
 * BEFORE the SDK call. NO `--yes` flag (reversible — CONTEXT line 49).
 *
 * Coverage:
 *   1. Identifier ENG-1 → resolves to UUID, calls archiveIssue(uuid).
 *   2. WSP-06 — no explicit workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE SDK.
 *   3. ISSUE_NOT_FOUND when identifier doesn't resolve.
 *   4. payload.success === false → LINEAR_API_ERROR.
 *   5. oclif command surface — NO `--yes` flag.
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

import IssueArchive, { runIssueArchive } from '@/commands/issue/archive.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { issueArchiveRuntime } from '@/lib/issue-archive-runtime.js'

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

interface ArchivePayload {
  success: boolean
  lastSyncId: number
  entity?: Record<string, unknown>
}

interface MockHandle {
  client: LinearClient
  issuesFn: ReturnType<typeof vi.fn>
  issueFn: ReturnType<typeof vi.fn>
  archiveIssueFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issues?: (args: unknown) => Promise<{ nodes: Array<Record<string, unknown>> }>
  issue?: (id: string) => Promise<unknown>
  archiveIssue?: (id: string) => Promise<ArchivePayload>
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
  const archiveIssueFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'archiveIssue', args: [id] })
    if (!opts.archiveIssue) throw new Error('mock client.archiveIssue not configured')
    return opts.archiveIssue(id)
  })
  const client = {
    issues: issuesFn,
    issue: issueFn,
    archiveIssue: archiveIssueFn,
  } as unknown as LinearClient
  return { client, issuesFn, issueFn, archiveIssueFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue archive' })
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

describe('issueArchiveRuntime — happy path', () => {
  it('Test 1: identifier ENG-1 → resolves UUID, calls archiveIssue(uuid), returns archived: true', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID, identifier: 'ENG-1' }] }),
      archiveIssue: async () => ({ success: true, lastSyncId: 1 }),
    })

    const out = await issueArchiveRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.archiveIssueFn).toHaveBeenCalledTimes(1)
    expect(handle.archiveIssueFn).toHaveBeenCalledWith(ISSUE_UUID)
    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1', archived: true })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(out).toMatchSnapshot('archive-success')
  })
})

describe('issueArchiveRuntime — WSP-06 enforcement', () => {
  it('Test 2: no explicit workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await issueArchiveRuntime({
        args: { identifier: 'ENG-1' },
        flags: {},
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

describe('issueArchiveRuntime — ISSUE_NOT_FOUND', () => {
  it('Test 3: identifier resolves to empty → ISSUE_NOT_FOUND; archiveIssue never called', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await issueArchiveRuntime({
        args: { identifier: 'ENG-999' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(handle.archiveIssueFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-ISSUE_NOT_FOUND')
    }
  })
})

describe('issueArchiveRuntime — payload.success === false', () => {
  it('Test 4: archiveIssue payload success=false → LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [{ id: ISSUE_UUID, identifier: 'ENG-1' }] }),
      archiveIssue: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await issueArchiveRuntime({
        args: { identifier: 'ENG-1' },
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

describe('IssueArchive oclif command', () => {
  it('Test 5: enableJsonFlag, args.identifier required, NO --yes flag', () => {
    expect(IssueArchive.enableJsonFlag).toBe(true)
    const args = IssueArchive.args as Record<string, { required?: boolean }>
    expect(args.identifier?.required).toBe(true)
    const flagNames = Object.keys(IssueArchive.flags)
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(flagNames).not.toContain('yes')
    expect(typeof runIssueArchive).toBe('function')
  })
})
