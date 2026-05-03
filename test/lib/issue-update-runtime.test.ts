/**
 * `issueUpdateRuntime` tests (Phase 2 PLAN 02-04 Task 2, ISS-04).
 *
 * Mirrors the create-runtime mock pattern; clears all 6 resolver caches
 * in `beforeEach` for isolation.
 *
 * Coverage:
 *   1. Single-field update — { title: 'New' } only.
 *   2. VALIDATION_NO_FIELDS — empty update throws BEFORE any SDK call.
 *   3. Three label modes co-exist: --labels (replace), --add-label, --remove-label.
 *   4. --add-label repeatable (oclif multiple) → addedLabelIds array.
 *   5. WSP-06 enforcement.
 *   6. --state resolves via resolveStateNameToId.
 *   7. --priority 0 (no priority) and --priority 4 (urgent) accepted.
 *   8. --description '' accepted as a clear-the-description value.
 *   9. payload.success === false → LINEAR_API_ERROR.
 *   10. Updated issue projected via parseFields.
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

import IssueUpdate, { runIssueUpdate } from '@/commands/issue/update.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import {
  _clearCycleCache,
  _clearLabelCache,
  _clearProjectCache,
  _clearProjectStatusCache,
  _clearStateCache,
  _clearTeamCache,
} from '@/core/resolvers/index.js'
import { issueUpdateRuntime } from '@/lib/issue-update-runtime.js'

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
const LABEL_P0_UUID = 'dddddddd-eeee-ffff-0000-111122223333'
const LABEL_BUG_UUID = 'eeeeeeee-ffff-0000-1111-222233334444'
const LABEL_FEATURE_UUID = 'ffffffff-0000-1111-2222-333344445555'
const LABEL_LEGACY_UUID = '00000000-1111-2222-3333-444455556666'

interface UpdateIssueInput {
  title?: string
  description?: string
  stateId?: string
  assigneeId?: string
  labelIds?: string[]
  addedLabelIds?: string[]
  removedLabelIds?: string[]
  priority?: number
  projectId?: string
  cycleId?: string
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
  issueLabelsFn: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  issues?: (args: unknown) => Promise<{ nodes: Array<Record<string, unknown>> }>
  issue?: (id: string) => Promise<unknown>
  updateIssue?: (id: string, input: UpdateIssueInput) => Promise<UpdatePayload>
  workflowStates?: (args: unknown) => Promise<{ nodes: Array<{ id: string; name: string }> }>
  issueLabels?: (args: unknown) => Promise<{ nodes: Array<{ id: string; name: string }> }>
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
  const issueLabelsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'issueLabels', args: [args] })
    if (!opts.issueLabels) throw new Error('mock client.issueLabels not configured')
    return opts.issueLabels(args)
  })
  const client = {
    issues: issuesFn,
    issue: issueFn,
    updateIssue: updateIssueFn,
    workflowStates: workflowStatesFn,
    issueLabels: issueLabelsFn,
  } as unknown as LinearClient
  return { client, issuesFn, issueFn, updateIssueFn, workflowStatesFn, issueLabelsFn, callLog }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue update' })
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  _clearTeamCache()
  _clearStateCache()
  _clearLabelCache()
  _clearProjectCache()
  _clearCycleCache()
  _clearProjectStatusCache()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

function fakeIssue(id: string, teamId: string): Record<string, unknown> {
  return {
    id,
    identifier: 'ENG-1',
    team: Promise.resolve({ id: teamId, key: 'ENG' }),
  }
}

function fakeUpdatedIssue(id: string): Record<string, unknown> {
  return {
    id,
    identifier: 'ENG-1',
    title: 'New',
    priority: 0,
    updatedAt: '2026-01-02T00:00:00Z',
    state: Promise.resolve({ name: 'In Progress' }),
    assignee: Promise.resolve(undefined),
    team: Promise.resolve({ key: 'ENG' }),
  }
}

describe('issueUpdateRuntime — single-field update', () => {
  it('Test 1: ENG-1 + --title New → resolves issue, calls updateIssue with exactly { title: "New" }', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', title: 'New' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateIssueFn).toHaveBeenCalledTimes(1)
    const callInput = handle.updateIssueFn.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callInput).toEqual({ title: 'New' })
    expect(Object.keys(callInput).length).toBe(1)
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(out).toMatchSnapshot('update-success-title-only')
  })
})

describe('issueUpdateRuntime — VALIDATION_NO_FIELDS', () => {
  it('Test 2: no field flags → VALIDATION_NO_FIELDS exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await issueUpdateRuntime({
        args: { identifier: 'ENG-1' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('VALIDATION_NO_FIELDS')
      expect(err.message).toMatch(/pass at least one of/)
      // No SDK calls — guard runs after WSP-06 but BEFORE issue resolution.
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-VALIDATION_NO_FIELDS')
    }
  })
})

describe('issueUpdateRuntime — three label modes co-exist', () => {
  it('Test 3: --labels p0,bug + --add-label feature + --remove-label legacy maps to all three keys', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      issueLabels: async () => ({
        nodes: [
          { id: LABEL_P0_UUID, name: 'p0' },
          { id: LABEL_BUG_UUID, name: 'bug' },
          { id: LABEL_FEATURE_UUID, name: 'feature' },
          { id: LABEL_LEGACY_UUID, name: 'legacy' },
        ],
      }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: {
        workspace: 'acme',
        labels: 'p0,bug',
        addLabel: ['feature'],
        removeLabel: ['legacy'],
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.updateIssueFn).toHaveBeenCalledTimes(1)
    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.labelIds).toEqual([LABEL_P0_UUID, LABEL_BUG_UUID])
    expect(input.addedLabelIds).toEqual([LABEL_FEATURE_UUID])
    expect(input.removedLabelIds).toEqual([LABEL_LEGACY_UUID])
  })

  it('Test 4: --add-label p0 --add-label bug (repeatable) → addedLabelIds = [p0, bug]', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      issueLabels: async () => ({
        nodes: [
          { id: LABEL_P0_UUID, name: 'p0' },
          { id: LABEL_BUG_UUID, name: 'bug' },
        ],
      }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: {
        workspace: 'acme',
        addLabel: ['p0', 'bug'],
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.addedLabelIds).toEqual([LABEL_P0_UUID, LABEL_BUG_UUID])
    expect(input.labelIds).toBeUndefined()
    expect(input.removedLabelIds).toBeUndefined()
  })
})

describe('issueUpdateRuntime — WSP-06 enforcement', () => {
  it('Test 5: no explicit workspace + active default → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await issueUpdateRuntime({
        args: { identifier: 'ENG-1' },
        flags: { title: 'New' },
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

describe('issueUpdateRuntime — state resolution', () => {
  it('Test 6: --state "In Progress" → resolveStateNameToId then input.stateId', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      workflowStates: async () => ({
        nodes: [{ id: STATE_UUID, name: 'In Progress' }],
      }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', state: 'In Progress' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.workflowStatesFn).toHaveBeenCalledTimes(1)
    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.stateId).toBe(STATE_UUID)
  })
})

describe('issueUpdateRuntime — priority edge cases', () => {
  it('Test 7a: --priority 0 (no priority) → input.priority = 0', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', priority: 0 },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.priority).toBe(0)
  })

  it('Test 7b: --priority 4 (urgent) → input.priority = 4', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', priority: 4 },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.priority).toBe(4)
  })
})

describe('issueUpdateRuntime — empty-string description', () => {
  it('Test 8: --description "" (empty string) → input.description = "" (clear-the-description)', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', description: '' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    const input = handle.updateIssueFn.mock.calls[0]?.[1] as UpdateIssueInput
    expect(input.description).toBe('')
  })
})

describe('issueUpdateRuntime — failure envelopes', () => {
  it('Test 9: payload.success === false → LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await issueUpdateRuntime({
        args: { identifier: 'ENG-1' },
        flags: { workspace: 'acme', title: 'New' },
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

describe('issueUpdateRuntime — projection', () => {
  it('Test 10: updated issue is projected via parseFields(flags.fields ?? "defaults", "issue")', async () => {
    const handle = makeMockClient({
      issues: async () => ({ nodes: [fakeIssue(ISSUE_UUID, TEAM_UUID)] }),
      updateIssue: async (id) => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeUpdatedIssue(id)),
      }),
    })

    const out = await issueUpdateRuntime({
      args: { identifier: 'ENG-1' },
      flags: { workspace: 'acme', title: 'New', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(out.data).toEqual({ id: ISSUE_UUID, identifier: 'ENG-1' })
  })
})

describe('IssueUpdate oclif command', () => {
  it('Test 11a: enableJsonFlag = true and declares --labels, --add-label, --remove-label as distinct flags', () => {
    expect(IssueUpdate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(IssueUpdate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'title',
      'description',
      'state',
      'assignee',
      'labels',
      'add-label',
      'remove-label',
      'priority',
      'project',
      'cycle',
    ]) {
      expect(flagNames).toContain(expected)
    }
    const args = IssueUpdate.args as Record<string, { required?: boolean }>
    expect(args.identifier?.required).toBe(true)
  })

  it('Test 11b: runIssueUpdate is exported as a named function', () => {
    expect(typeof runIssueUpdate).toBe('function')
  })
})
