/**
 * Unit tests for `resolveStateNameToId` (Phase 2 PLAN 02-02 Task 1, ISS-05).
 *
 * `@linear/sdk` is mocked at the module level so the transport's typed-error
 * `instanceof` discrimination resolves to the SAME class identities tests
 * `new` and throw — mirrors the pattern in `test/core/transport/rate-limit.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  }
})

import type { LinearClient } from '@linear/sdk'
import { RatelimitedLinearError as RealRatelimitedLinearError } from '@linear/sdk'

import { LinearAgentError } from '@/core/errors/index.js'
import { _clearStateCache, resolveStateNameToId } from '@/core/resolvers/state.js'

// vi.mock above replaces @linear/sdk at module-load with a class whose
// constructor accepts a test-friendly options bag. Cast away the real SDK
// constructor signature for the mock-construction call site.
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (opts?: {
  message?: string
  retryAfter?: number
}) => Error

interface StateNode {
  id: string
  name: string
}

function makeClient(states: StateNode[]) {
  const workflowStates = vi.fn(async () => ({ nodes: states }))
  return {
    client: { workflowStates } as unknown as LinearClient,
    workflowStates,
  }
}

const TEAM_A = 'team-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TEAM_B = 'team-bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const STATE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('resolveStateNameToId', () => {
  beforeEach(() => {
    _clearStateCache()
  })

  it('Test 1: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, workflowStates } = makeClient([])
    const id = await resolveStateNameToId(client, 'acme', TEAM_A, STATE_UUID)
    expect(id).toBe(STATE_UUID)
    expect(workflowStates).not.toHaveBeenCalled()
  })

  it('Test 2: name lookup — calls workflowStates with team filter and returns matching id', async () => {
    const { client, workflowStates } = makeClient([
      { id: 'state-todo', name: 'Todo' },
      { id: 'state-progress', name: 'In Progress' },
      { id: 'state-done', name: 'Done' },
    ])
    const id = await resolveStateNameToId(client, 'acme', TEAM_A, 'In Progress')
    expect(id).toBe('state-progress')
    expect(workflowStates).toHaveBeenCalledTimes(1)
    expect(workflowStates).toHaveBeenCalledWith({
      filter: { team: { id: { eq: TEAM_A } } },
      first: 50,
    })
  })

  it('Test 3: case-insensitive lookup', async () => {
    const { client } = makeClient([{ id: 'state-progress', name: 'In Progress' }])
    expect(await resolveStateNameToId(client, 'acme', TEAM_A, 'in progress')).toBe('state-progress')
    _clearStateCache()
    expect(await resolveStateNameToId(client, 'acme', TEAM_A, 'In Progress')).toBe('state-progress')
    _clearStateCache()
    expect(await resolveStateNameToId(client, 'acme', TEAM_A, 'IN PROGRESS')).toBe('state-progress')
  })

  it('Test 4: cache hit — same workspace+team triggers exactly ONE SDK call across N requests', async () => {
    const { client, workflowStates } = makeClient([
      { id: 'state-todo', name: 'Todo' },
      { id: 'state-progress', name: 'In Progress' },
      { id: 'state-done', name: 'Done' },
      { id: 'state-cancelled', name: 'Cancelled' },
      { id: 'state-backlog', name: 'Backlog' },
    ])
    const a = await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo')
    const b = await resolveStateNameToId(client, 'acme', TEAM_A, 'Done')
    const c = await resolveStateNameToId(client, 'acme', TEAM_A, 'Backlog')
    expect(a).toBe('state-todo')
    expect(b).toBe('state-done')
    expect(c).toBe('state-backlog')
    expect(workflowStates).toHaveBeenCalledTimes(1)
  })

  it('Test 5: cache key partition by teamId — different teams trigger separate SDK calls', async () => {
    const { client, workflowStates } = makeClient([{ id: 'state-todo', name: 'Todo' }])
    await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo')
    await resolveStateNameToId(client, 'acme', TEAM_B, 'Todo')
    expect(workflowStates).toHaveBeenCalledTimes(2)
  })

  it('Test 6: cache key partition by workspace — different workspaces trigger separate SDK calls', async () => {
    const { client, workflowStates } = makeClient([{ id: 'state-todo', name: 'Todo' }])
    await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo')
    await resolveStateNameToId(client, 'beta', TEAM_A, 'Todo')
    expect(workflowStates).toHaveBeenCalledTimes(2)
  })

  it('Test 7: miss — throws WORKFLOW_STATE_NOT_FOUND with sorted available list', async () => {
    const { client } = makeClient([
      { id: 'state-todo', name: 'Todo' },
      { id: 'state-progress', name: 'In Progress' },
      { id: 'state-done', name: 'Done' },
    ])
    await expect(resolveStateNameToId(client, 'acme', TEAM_A, 'BogusState')).rejects.toMatchObject({
      code: 'WORKFLOW_STATE_NOT_FOUND',
    })
    _clearStateCache()
    try {
      await resolveStateNameToId(client, 'acme', TEAM_A, 'BogusState')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKFLOW_STATE_NOT_FOUND')
      expect(err.message).toMatch(/workflow state not found: BogusState/)
      expect(err.details).toEqual({
        teamId: TEAM_A,
        requested: 'BogusState',
        available: ['done', 'in progress', 'todo'],
      })
    }
  })

  it('Test 8: rate-limit propagation — RatelimitedLinearError surfaces as classified LinearAgentError code RATELIMITED', async () => {
    const workflowStates = vi.fn(async () => {
      throw new RatelimitedLinearError({ retryAfter: 1 })
    })
    const client = { workflowStates } as unknown as LinearClient
    try {
      await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo', { maxAttempts: 1 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('RATELIMITED')
    }
  })

  it('Test 9: _clearStateCache — next call hits the SDK again', async () => {
    const { client, workflowStates } = makeClient([{ id: 'state-todo', name: 'Todo' }])
    await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo')
    expect(workflowStates).toHaveBeenCalledTimes(1)
    _clearStateCache()
    await resolveStateNameToId(client, 'acme', TEAM_A, 'Todo')
    expect(workflowStates).toHaveBeenCalledTimes(2)
  })
})
