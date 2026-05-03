/**
 * Unit tests for `resolveProjectStatusId` (Phase 2 PLAN 02-02 Task 2).
 *
 * Resolves a Project's *current status* by name. Used by `project update-status`
 * to call `client.updateProject(id, { statusId })` — NOT `updateProjectStatus`.
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
import {
  _clearProjectStatusCache,
  resolveProjectStatusId,
} from '@/core/resolvers/project-status.js'

interface ProjectStatusNode {
  id: string
  name: string
}

function makeClient(statuses: ProjectStatusNode[]) {
  const projectStatuses = vi.fn(async () => ({ nodes: statuses }))
  return {
    client: { projectStatuses } as unknown as LinearClient,
    projectStatuses,
  }
}

const STATUS_UUID = 'aaaaaaaa-1111-2222-3333-444444444444'

describe('resolveProjectStatusId', () => {
  beforeEach(() => {
    _clearProjectStatusCache()
  })

  it('Test 5: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, projectStatuses } = makeClient([])
    const id = await resolveProjectStatusId(client, 'acme', STATUS_UUID)
    expect(id).toBe(STATUS_UUID)
    expect(projectStatuses).not.toHaveBeenCalled()
  })

  it('Test 6: name lookup — case-insensitive, calls projectStatuses once and caches', async () => {
    const { client, projectStatuses } = makeClient([
      { id: 'status-on-track-id', name: 'On Track' },
      { id: 'status-at-risk-id', name: 'At Risk' },
      { id: 'status-off-track-id', name: 'Off Track' },
    ])
    expect(projectStatuses).not.toHaveBeenCalled()
    expect(await resolveProjectStatusId(client, 'acme', 'On Track')).toBe('status-on-track-id')
    expect(await resolveProjectStatusId(client, 'acme', 'on track')).toBe('status-on-track-id')
    expect(await resolveProjectStatusId(client, 'acme', 'AT RISK')).toBe('status-at-risk-id')
    expect(projectStatuses).toHaveBeenCalledTimes(1)
    expect(projectStatuses).toHaveBeenCalledWith({ first: 50 })
  })

  it('Test 7: miss — throws PROJECT_NOT_FOUND (re-used taxonomy) with sorted available list', async () => {
    const { client } = makeClient([
      { id: 'status-on-track-id', name: 'On Track' },
      { id: 'status-at-risk-id', name: 'At Risk' },
    ])
    try {
      await resolveProjectStatusId(client, 'acme', 'BogusStatus')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('PROJECT_NOT_FOUND')
      expect(err.message).toMatch(/project status not found: BogusStatus/)
      expect(err.details).toEqual({
        workspace: 'acme',
        requested: 'BogusStatus',
        available: ['at risk', 'on track'],
      })
    }
  })
})
