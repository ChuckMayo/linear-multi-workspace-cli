/**
 * `issueCreateRuntime` tests (Phase 2 PLAN 02-04 Task 1, ISS-03).
 *
 * Mirrors the Phase 1 mock pattern: vi.mock('@linear/sdk') exports the typed
 * error class hierarchy so the transport's instanceof checks resolve to the
 * SAME class identities tests `new` and throw. All 6 resolver caches are
 * cleared in `beforeEach` for isolation.
 *
 * Coverage:
 *   1. Minimum input — title + team only → resolveTeamId then client.createIssue
 *      with exactly { teamId, title }.
 *   2. Missing title → USAGE_ERROR exit 2 BEFORE any SDK call.
 *   3. Missing team → USAGE_ERROR exit 2 BEFORE any SDK call.
 *   4. WSP-06 — no explicit selector + active workspace → WORKSPACE_REQUIRED_FOR_WRITE.
 *   5. Full input — all 9 optional fields resolved + createIssue input matches.
 *   6. --assignee me → resolves via client.viewer.id.
 *   7. --assignee email — match found / no match throws apiError.
 *   8. --assignee uuid — passthrough, no SDK call.
 *   9. payload.success === false → LINEAR_API_ERROR with details.lastSyncId.
 *   10. Resolver-not-found surfaces (state, label, project, cycle, team).
 *   11. --parent ENG-42 — issues filter resolves to UUID; --parent uuid passthrough.
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

import IssueCreate, { runIssueCreate } from '@/commands/issue/create.js'
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
import { issueCreateRuntime } from '@/lib/issue-create-runtime.js'

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

const TEAM_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const STATE_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const ASSIGNEE_UUID = 'cccccccc-dddd-eeee-ffff-000011112222'
const LABEL_P0_UUID = 'dddddddd-eeee-ffff-0000-111122223333'
const LABEL_BUG_UUID = 'eeeeeeee-ffff-0000-1111-222233334444'
const PROJECT_UUID = 'ffffffff-0000-1111-2222-333344445555'
const CYCLE_UUID = '00000000-1111-2222-3333-444455556666'
const PARENT_UUID = '11111111-2222-3333-4444-555566667777'
const NEW_ISSUE_UUID = '22222222-3333-4444-5555-666677778888'

interface CreatePayload {
  success: boolean
  lastSyncId: number
  issue?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface MockHandle {
  client: LinearClient
  createIssueFn: ReturnType<typeof vi.fn>
  teamsFn: ReturnType<typeof vi.fn>
  workflowStatesFn: ReturnType<typeof vi.fn>
  issueLabelsFn: ReturnType<typeof vi.fn>
  projectsFn: ReturnType<typeof vi.fn>
  teamFn: ReturnType<typeof vi.fn>
  usersFn: ReturnType<typeof vi.fn>
  issuesFn: ReturnType<typeof vi.fn>
  viewerGet: ReturnType<typeof vi.fn>
  callLog: Array<{ method: string; args: unknown[] }>
}

interface MockOpts {
  createIssue?: (input: Record<string, unknown>) => Promise<CreatePayload>
  teams?: () => Promise<{ nodes: Array<{ id: string; key: string; name: string }> }>
  workflowStates?: (args: unknown) => Promise<{ nodes: Array<{ id: string; name: string }> }>
  issueLabels?: (args: unknown) => Promise<{ nodes: Array<{ id: string; name: string }> }>
  projects?: () => Promise<{ nodes: Array<{ id: string; name: string }> }>
  team?: (id: string) => Promise<{
    cycles: (args: unknown) => Promise<{
      nodes: Array<{ id: string; number: number; name?: string | null; isActive?: boolean }>
    }>
  }>
  users?: (
    args: unknown,
  ) => Promise<{ nodes: Array<{ id: string; email?: string; name?: string }> }>
  issues?: (args: unknown) => Promise<{ nodes: Array<{ id: string }> }>
  viewer?: { id: string } | Promise<{ id: string }>
}

function makeMockClient(opts: MockOpts): MockHandle {
  const callLog: Array<{ method: string; args: unknown[] }> = []
  const createIssueFn = vi.fn(async (input: Record<string, unknown>) => {
    callLog.push({ method: 'createIssue', args: [input] })
    if (!opts.createIssue) throw new Error('mock client.createIssue not configured')
    return opts.createIssue(input)
  })
  const teamsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'teams', args: [args] })
    if (!opts.teams) throw new Error('mock client.teams not configured')
    return opts.teams()
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
  const projectsFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'projects', args: [args] })
    if (!opts.projects) throw new Error('mock client.projects not configured')
    return opts.projects()
  })
  const teamFn = vi.fn(async (id: string) => {
    callLog.push({ method: 'team', args: [id] })
    if (!opts.team) throw new Error('mock client.team not configured')
    return opts.team(id)
  })
  const usersFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'users', args: [args] })
    if (!opts.users) throw new Error('mock client.users not configured')
    return opts.users(args)
  })
  const issuesFn = vi.fn(async (args: unknown) => {
    callLog.push({ method: 'issues', args: [args] })
    if (!opts.issues) throw new Error('mock client.issues not configured')
    return opts.issues(args)
  })
  const viewerGet = vi.fn(() => {
    callLog.push({ method: 'viewer', args: [] })
    if (opts.viewer === undefined) throw new Error('mock client.viewer not configured')
    return opts.viewer
  })
  const client = {
    createIssue: createIssueFn,
    teams: teamsFn,
    workflowStates: workflowStatesFn,
    issueLabels: issueLabelsFn,
    projects: projectsFn,
    team: teamFn,
    users: usersFn,
    issues: issuesFn,
    get viewer() {
      return viewerGet()
    },
  } as unknown as LinearClient
  return {
    client,
    createIssueFn,
    teamsFn,
    workflowStatesFn,
    issueLabelsFn,
    projectsFn,
    teamFn,
    usersFn,
    issuesFn,
    viewerGet,
    callLog,
  }
}

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'issue create' })
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

function fakeCreatedIssue(id: string, identifier = 'ENG-1'): Record<string, unknown> {
  return {
    id,
    identifier,
    title: 'T',
    priority: 0,
    updatedAt: '2026-01-02T00:00:00Z',
    state: Promise.resolve({ name: 'Backlog' }),
    assignee: Promise.resolve(undefined),
    team: Promise.resolve({ key: 'ENG' }),
  }
}

describe('issueCreateRuntime — minimum input', () => {
  it('Test 1: title + team only → resolveTeamId then createIssue with exactly { teamId, title }', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    const out = await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.teamsFn).toHaveBeenCalledTimes(1)
    expect(handle.createIssueFn).toHaveBeenCalledTimes(1)
    const callInput = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callInput).toEqual({ teamId: TEAM_UUID, title: 'T' })
    expect(Object.keys(callInput).length).toBe(2)
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')
    expect(out).toMatchSnapshot('create-success-minimum')
  })
})

describe('issueCreateRuntime — required-flag validation (BEFORE any SDK call)', () => {
  it('Test 2: missing title → USAGE_ERROR exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(4)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', team: 'ENG' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: factory,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(handle.callLog).toHaveLength(0)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-USAGE_ERROR-missing-title')
    }
  })

  it('Test 3: missing team → USAGE_ERROR exit 2 BEFORE any SDK call', async () => {
    const handle = makeMockClient({})

    expect.assertions(3)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('USAGE_ERROR')
      expect(handle.callLog).toHaveLength(0)
    }
  })
})

describe('issueCreateRuntime — WSP-06 enforcement', () => {
  it('Test 4: no explicit workspace + active default → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any SDK call', async () => {
    const handle = makeMockClient({})
    const factory = vi.fn(() => handle.client)

    expect.assertions(5)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { title: 'T', team: 'ENG' },
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

describe('issueCreateRuntime — full input with all 9 optional fields', () => {
  it('Test 5: title + team + description + state + assignee email + labels + project + cycle + priority + parent', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      workflowStates: async () => ({
        nodes: [
          { id: STATE_UUID, name: 'In Progress' },
          { id: 'state-other', name: 'Done' },
        ],
      }),
      issueLabels: async () => ({
        nodes: [
          { id: LABEL_P0_UUID, name: 'p0' },
          { id: LABEL_BUG_UUID, name: 'bug' },
          { id: 'label-other', name: 'other' },
        ],
      }),
      projects: async () => ({ nodes: [{ id: PROJECT_UUID, name: 'Roadmap' }] }),
      team: async () => ({
        cycles: async () => ({
          nodes: [
            { id: 'cycle-prev', number: 1, isActive: false },
            { id: CYCLE_UUID, number: 2, isActive: true },
            { id: 'cycle-next', number: 3, isActive: false },
          ],
        }),
      }),
      users: async () => ({
        nodes: [{ id: ASSIGNEE_UUID, email: 'me@x.com' }],
      }),
      issues: async () => ({ nodes: [{ id: PARENT_UUID }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 100,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: {
        workspace: 'acme',
        title: 'T',
        team: 'ENG',
        description: 'D',
        state: 'In Progress',
        assignee: 'me@x.com',
        labels: 'p0,bug',
        project: 'Roadmap',
        cycle: 'current',
        priority: 1,
        parent: 'ENG-42',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.createIssueFn).toHaveBeenCalledTimes(1)
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.teamId).toBe(TEAM_UUID)
    expect(input.title).toBe('T')
    expect(input.description).toBe('D')
    expect(input.stateId).toBe(STATE_UUID)
    expect(input.assigneeId).toBe(ASSIGNEE_UUID)
    expect(input.labelIds).toEqual([LABEL_P0_UUID, LABEL_BUG_UUID])
    expect(input.projectId).toBe(PROJECT_UUID)
    expect(input.cycleId).toBe(CYCLE_UUID)
    expect(input.priority).toBe(1)
    expect(input.parentId).toBe(PARENT_UUID)
  })
})

describe('issueCreateRuntime — assignee resolution', () => {
  it('Test 6: --assignee me → resolves via client.viewer.id', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      viewer: { id: ASSIGNEE_UUID },
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG', assignee: 'me' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.viewerGet).toHaveBeenCalled()
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.assigneeId).toBe(ASSIGNEE_UUID)
  })

  it('Test 7: --assignee email match → assigneeId; no match → LINEAR_API_ERROR', async () => {
    // Match case
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      users: async () => ({ nodes: [{ id: ASSIGNEE_UUID, email: 'a@x.com' }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG', assignee: 'a@x.com' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.assigneeId).toBe(ASSIGNEE_UUID)

    // No-match case
    const handle2 = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      users: async () => ({ nodes: [] }),
    })

    expect.assertions(5)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG', assignee: 'noone@x.com' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle2.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(err.message).toMatch(/assignee not found/)
      expect(handle2.createIssueFn).not.toHaveBeenCalled()
    }
  })

  it('Test 8: --assignee uuid → passthrough, no SDK lookup call', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG', assignee: ASSIGNEE_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.usersFn).not.toHaveBeenCalled()
    expect(handle.viewerGet).not.toHaveBeenCalled()
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.assigneeId).toBe(ASSIGNEE_UUID)
  })
})

describe('issueCreateRuntime — failure envelopes', () => {
  it('Test 9: createIssue success=false → LINEAR_API_ERROR with details.lastSyncId', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      createIssue: async () => ({ success: false, lastSyncId: 42 }),
    })

    expect.assertions(3)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG' },
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

  it('Test 10a: unknown state → WORKFLOW_STATE_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      workflowStates: async () => ({ nodes: [{ id: 'state-todo', name: 'Todo' }] }),
    })

    expect.assertions(3)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG', state: 'BogusState' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('WORKFLOW_STATE_NOT_FOUND')
      expect(handle.createIssueFn).not.toHaveBeenCalled()
    }
  })

  it('Test 10b: unknown label → LABEL_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      issueLabels: async () => ({ nodes: [{ id: 'label-known', name: 'known' }] }),
    })

    expect.assertions(2)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG', labels: 'bogus' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('LABEL_NOT_FOUND')
    }
  })

  it('Test 10c: unknown project → PROJECT_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      projects: async () => ({ nodes: [{ id: 'proj-other', name: 'OtherProject' }] }),
    })

    expect.assertions(2)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG', project: 'BogusProject' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('PROJECT_NOT_FOUND')
    }
  })

  it('Test 10d: unknown cycle → CYCLE_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      team: async () => ({
        cycles: async () => ({ nodes: [{ id: 'c1', number: 1, isActive: true }] }),
      }),
    })

    expect.assertions(2)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'ENG', cycle: 'BogusName' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('CYCLE_NOT_FOUND')
    }
  })

  it('Test 10e: unknown team → TEAM_NOT_FOUND', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'OPS', name: 'Operations' }] }),
    })

    expect.assertions(2)
    try {
      await issueCreateRuntime({
        args: {},
        flags: { workspace: 'acme', title: 'T', team: 'BOGUS' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => handle.client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('TEAM_NOT_FOUND')
    }
  })
})

describe('issueCreateRuntime — parent resolution', () => {
  it('Test 11a: --parent ENG-42 → resolves via client.issues identifier filter', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      issues: async () => ({ nodes: [{ id: PARENT_UUID }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG', parent: 'ENG-42' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).toHaveBeenCalledTimes(1)
    const issuesArgs = handle.issuesFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(issuesArgs).toMatchObject({
      filter: { team: { key: { eq: 'ENG' } }, number: { eq: 42 } },
      first: 1,
    })
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.parentId).toBe(PARENT_UUID)
  })

  it('Test 11b: --parent uuid → passthrough, no issues SDK call', async () => {
    const handle = makeMockClient({
      teams: async () => ({ nodes: [{ id: TEAM_UUID, key: 'ENG', name: 'Engineering' }] }),
      createIssue: async () => ({
        success: true,
        lastSyncId: 1,
        issue: Promise.resolve(fakeCreatedIssue(NEW_ISSUE_UUID)),
      }),
    })

    await issueCreateRuntime({
      args: {},
      flags: { workspace: 'acme', title: 'T', team: 'ENG', parent: PARENT_UUID },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => handle.client,
    })

    expect(handle.issuesFn).not.toHaveBeenCalled()
    const input = handle.createIssueFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.parentId).toBe(PARENT_UUID)
  })
})

describe('IssueCreate oclif command', () => {
  it('Test 12a: enableJsonFlag = true and declares the documented flags', () => {
    expect(IssueCreate.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(IssueCreate.flags)
    for (const expected of [
      'pretty',
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'title',
      'team',
      'description',
      'state',
      'assignee',
      'labels',
      'project',
      'cycle',
      'priority',
      'parent',
    ]) {
      expect(flagNames).toContain(expected)
    }
  })

  it('Test 12b: runIssueCreate is exported as a named function', () => {
    expect(typeof runIssueCreate).toBe('function')
  })
})
