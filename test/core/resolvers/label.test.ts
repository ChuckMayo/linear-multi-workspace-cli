/**
 * Unit tests for `resolveLabelId` / `resolveLabelIds` (Phase 2 PLAN 02-02 Task 1).
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

import { LinearAgentError } from '@/core/errors/index.js'
import { _clearLabelCache, resolveLabelId, resolveLabelIds } from '@/core/resolvers/label.js'

interface LabelNode {
  id: string
  name: string
}

function makeClient(labels: LabelNode[]) {
  const issueLabels = vi.fn(async () => ({ nodes: labels }))
  return {
    client: { issueLabels } as unknown as LinearClient,
    issueLabels,
  }
}

const TEAM_A = 'team-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LABEL_UUID = 'aaaaaaaa-1111-2222-3333-444444444444'

describe('resolveLabelId / resolveLabelIds', () => {
  beforeEach(() => {
    _clearLabelCache()
  })

  it('Test 15: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, issueLabels } = makeClient([])
    const id = await resolveLabelId(client, 'acme', TEAM_A, LABEL_UUID)
    expect(id).toBe(LABEL_UUID)
    expect(issueLabels).not.toHaveBeenCalled()
  })

  it('Test 16: name lookup — calls issueLabels with team filter and returns matching id', async () => {
    const { client, issueLabels } = makeClient([
      { id: 'label-p0-id', name: 'p0' },
      { id: 'label-bug-id', name: 'bug' },
      { id: 'label-feature-id', name: 'feature' },
    ])
    const id = await resolveLabelId(client, 'acme', TEAM_A, 'p0')
    expect(id).toBe('label-p0-id')
    expect(issueLabels).toHaveBeenCalledTimes(1)
    expect(issueLabels).toHaveBeenCalledWith({
      filter: { team: { id: { eq: TEAM_A } } },
      first: 250,
    })
  })

  it('Test 17: resolveLabelIds — mixed UUID + names resolve in input order with one bulk lookup', async () => {
    const { client, issueLabels } = makeClient([
      { id: 'label-p0-id', name: 'p0' },
      { id: 'label-bug-id', name: 'bug' },
    ])
    const ids = await resolveLabelIds(client, 'acme', TEAM_A, ['p0', 'bug', LABEL_UUID])
    expect(ids).toEqual(['label-p0-id', 'label-bug-id', LABEL_UUID])
    // Only ONE SDK call (UUID passthrough doesn't fetch; the two name lookups share cache).
    expect(issueLabels).toHaveBeenCalledTimes(1)
  })

  it('Test 18: cache by workspace+team — two calls trigger ONE bulk lookup', async () => {
    const { client, issueLabels } = makeClient([
      { id: 'label-p0-id', name: 'p0' },
      { id: 'label-bug-id', name: 'bug' },
    ])
    await resolveLabelId(client, 'acme', TEAM_A, 'p0')
    await resolveLabelId(client, 'acme', TEAM_A, 'bug')
    expect(issueLabels).toHaveBeenCalledTimes(1)
  })

  it('Test 19: miss — throws LABEL_NOT_FOUND with sorted available list', async () => {
    const { client } = makeClient([
      { id: 'label-p0-id', name: 'p0' },
      { id: 'label-bug-id', name: 'bug' },
    ])
    try {
      await resolveLabelId(client, 'acme', TEAM_A, 'BogusLabel')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LABEL_NOT_FOUND')
      expect(err.message).toMatch(/label not found: BogusLabel/)
      expect(err.details).toEqual({
        teamId: TEAM_A,
        requested: 'BogusLabel',
        available: ['bug', 'p0'],
      })
    }
  })
})
