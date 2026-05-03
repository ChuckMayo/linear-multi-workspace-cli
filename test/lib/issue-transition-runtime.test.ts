/**
 * `issueTransitionRuntime` tests (Phase 2 PLAN 02-03 Task 2, ISS-05).
 *
 * Mirrors the Phase 1 mock pattern: vi.mock('@linear/sdk') exports the typed
 * error class hierarchy so the transport's instanceof checks resolve to the
 * SAME class identities tests `new` and throw. The state-resolver cache is
 * cleared in `beforeEach` for isolation.
 *
 * Coverage:
 *   1. Happy path — identifier ENG-123 + state name "In Progress" → calls
 *      client.updateIssue(uuid, { stateId }) in the right order.
 *   2. WSP-06 — without explicit workspace, throws WORKSPACE_REQUIRED_FOR_WRITE
 *      BEFORE any SDK call (factory tracks zero calls).
 *   3. allowActiveWorkspaceWrite=true unblocks the call.
 *   4. Unknown state name → WORKFLOW_STATE_NOT_FOUND with details.available.
 *   5. Issue not found → ISSUE_NOT_FOUND; updateIssue never called.
 *   6. updateIssue success=false → LINEAR_API_ERROR with details.lastSyncId.
 *   7. Success envelope returns the projected issue + meta.
 *   8. State input is already a UUID — no workflowStates SDK call.
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

import IssueTransition, { runIssueTransition } from '@/commands/issue/transition.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { _clearStateCache } from '@/core/resolvers/index.js'
import { issueTransitionRuntime } from '@/lib/issue-transition-runtime.js'

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
const TEAM_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const STATE_UUID = 'cccccccc-dddd-eeee-ffff-000011112222'

interface IssuesArgs {
  first?: number
  filter?: unknown
}

interface UpdateIssueInput {
  stateId?: string
}

interface UpdatePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  issuesFn: ReturnType<typeof vi.fn>
  issueFn: ReturnType<typeof vi.fn>
  updateIssueFn: ReturnType<typeof vi.fn>
  workflowStatesFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issues?: (args: IssuesArgs) => Promise<unknown>
  issue?: (id: string) => Promise<unknown>
  updateIssue?: (id: string, input: UpdateIssueInput) => Promise<UpdatePayload>
  workflowStates?: (args: unknown) => Promise<{ nodes: Array<{ id: string; name: string }> }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const issuesFn = vi.fn(async (args: IssuesArgs) => {
    callLog.push({ method: 'issues', args: [args] })
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const issueFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'issue', args: [id] })
    if (!opts.issue) throw new Error('mock client.issue not configured')
    return opts.issue(id)
  })
  const updateIssueFn = vi.fn(async (id: string, input: UpdateIssueInput) => {
    callLog.push({ method: 'updateIssue', args: [id, input] })
    if (!opts.updateIssue) throw new Error('mock client.updateIssue not configured')
    return opts.updateIssue(id, input)
  })
  const workflowStatesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'workflowStates', args: [args] })
    if (!opts.workflowStates) throw new Error('mock client.workflowStates not configured')
    return opts.workflowStates(args)
  })
  const client = {
    issues: issuesFn,
    issue: issueFn,
    updateIssue: updateIssueFn,
    workflowStates: workflowStatesFn,
  } as unknown as LinearClient
  return { client, issuesFn, issueFn, updateIssueFn, workflowStatesFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue transition' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearStateCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

// Helper: builds a fake "issue" returned from `client.issues({ filter })` with
// a lazy team getter so the runtime can read teamId via `await issue.team`.
function fakeIssue(id: string, teamId: string, identifier = 'ENG-123'): Record<string, unknown> {
  return {
    id,
    identifier,
    team: Promise.resolve({ id: teamId, key: 'ENG' }),
  }
}

function fakeUpdatedIssue(id: string, identifier = 'ENG-123'): Record<string, unknown> {
  return {
    id,
    identifier,
    title: 'updated',
    priority: 0,
    updatedAt: '2026-01-02T00:00:00Z',
    state: Promise.resolve({ name: 'In Progress' }),
    assignee: Promise.resolve({ email: 'alice@example.com' }),
    team: Promise.resolve({ key: 'ENG' }),
  }
}

describe('issueTransitionRuntime — happy path', () => {
  it('Test 1: ENG-123 + state name "In Progress" → resolves identifier, fetches team, resolves state, updates issue', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID, 'ENG-123')] }),
      workflowStates: async () => ({
        nodes: [
          { id: STATE_UUID, name: 'In Progress' },
          { id: 'state-other', name: 'Done' },
        ],
      }),
      updateIssue: async (id, input) =>
        ({
          success: true,
          lastSyncId: 100,
          issue: Promise.resolve(fakeUpdatedIssue(id)),
          _input: input,
        }) as UpdatePayload,
    })

    const out = await issueTransitionRuntime({
      args: { identifier: 'ENG-123', state: 'In Progress' },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    // Call sequence: issues (resolve identifier) → workflowStates (state-resolver) → updateIssue
    const methods = handle.callLog.map((c) => c.method)
    expect(methods).toEqual(['issues', 'workflowStates', 'updateIssue'])
    expect(handle.updateIssueFn).toHaveBeenCalledWith(ISSUE_UUID, { stateId: STATE_UUID })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(out.data).toMatchObject({ id: ISSUE_UUID, identifier: 'ENG-123' })
    expect(out).toMatchSnapshot('transition-success-identifier-name')
  })

  it('Test 7: success envelope projects per --fields and populates meta.workspace + workspaceSource', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      workflowStates: async () => ({ nodes: [{ id: STATE_UUID, name: 'In Progress' }] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await issueTransitionRuntime({
      args: { identifier: 'ENG-123', state: 'In Progress' },
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-123' })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
  })
})

describe('issueTransitionRuntime — WSP-06 enforcement', () => {
  it('Test 2: without explicit workspace, throws WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await issueTransitionRuntime({
        args: { identifier: 'ENG-123', state: 'In Progress' },
        flags: {}, // no workspace
        env: {}, // no LINEAR_WORKSPACE
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      // Critical: zero SDK calls happened.
      expect(handle.callLog).toHaveLength(0)
      expect(handle.issuesFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WSP-06-write-guard')
    }
  })

  it('Test 3: --allow-active-workspace-write unblocks the call when active is the resolved source', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      workflowStates: async () => ({ nodes: [{ id: STATE_UUID, name: 'In Progress' }] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await issueTransitionRuntime({
      args: { identifier: 'ENG-123', state: 'In Progress' },
      flags: { allowActiveWorkspaceWrite: true },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateIssueFn).toHaveBeenCalledTimes(1)
    expect(out.meta.workspaceSource).toBe('active')
  })
})

describe('issueTransitionRuntime — failure envelopes', () => {
  it('Test 4: unknown state name surfaces WORKFLOW_STATE_NOT_FOUND with details.available', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      workflowStates: async () => ({
        nodes: [
          { id: 'state-todo', name: 'Todo' },
          { id: 'state-done', name: 'Done' },
        ],
      }),
    })

    expect.assertions(5)
    try {
      await issueTransitionRuntime({
        args: { identifier: 'ENG-123', state: 'BogusState' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKFLOW_STATE_NOT_FOUND')
      expect(err.details).toMatchObject({
        teamId: TEAM_UUID,
        requested: 'BogusState',
        available: ['done', 'todo'],
      })
      // updateIssue must NOT be called.
      expect(handle.updateIssueFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WORKFLOW_STATE_NOT_FOUND')
    }
  })

  it('Test 5: issue identifier not found → ISSUE_NOT_FOUND; updateIssue NOT called', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [] }),
    })

    expect.assertions(4)
    try {
      await issueTransitionRuntime({
        args: { identifier: 'ENG-999', state: 'In Progress' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('ISSUE_NOT_FOUND')
      expect(err.details).toEqual({ ref: 'ENG-999' })
      expect(handle.updateIssueFn).not.toHaveBeenCalled()
    }
  })

  it('Test 6: updateIssue returns success=false → LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      workflowStates: async () => ({ nodes: [{ id: STATE_UUID, name: 'In Progress' }] }),
      updateIssue: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await issueTransitionRuntime({
        args: { identifier: 'ENG-123', state: 'In Progress' },
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

describe('issueTransitionRuntime — UUID input passthrough', () => {
  it('Test 8: state input is already a UUID — no workflowStates SDK call', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueTransitionRuntime({
      args: { identifier: 'ENG-123', state: STATE_UUID },
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn).not.toHaveBeenCalled()
    expect(handle.updateIssueFn).toHaveBeenCalledWith(ISSUE_UUID, { stateId: STATE_UUID })
  })
})

describe('IssueTransition oclif command', () => {
  it('Test 9a: enableJsonFlag = true and declares the documented flags + args', () => {
    expect(IssueTransition.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(IssueTransition.flags)
    for (const expected of ['pretty', 'workspace', 'allow-active-workspace-write', 'fields']) {
      expect(flagNames).toContain(expected)
    }
    const args = IssueTransition.args as Record<string, { required?: boolean }>
    expect(args.identifier?.required).toBe(true)
    expect(args.state?.required).toBe(true)
  })

  it('Test 9b: runIssueTransition is exported as a named function', () => {
    expect(typeof runIssueTransition).toBe('function')
  })
})
