/**
 * Unit tests for `resolveProjectId` (Phase 2 PLAN 02-02 Task 2).
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
import { _clearProjectCache, resolveProjectId } from '@/core/resolvers/project.js'

interface ProjectNode {
  id: string
  name: string
}

function makeClient(projects: ProjectNode[]) {
  const projectsFn = vi.fn(async () => ({ nodes: projects }))
  return {
    client: { projects: projectsFn } as unknown as LinearClient,
    projects: projectsFn,
  }
}

const PROJECT_UUID = '11111111-2222-3333-4444-555555555555'

describe('resolveProjectId', () => {
  beforeEach(() => {
    _clearProjectCache()
  })

  it('Test 1: UUID passthrough — returns input unchanged, never calls SDK', async () => {
    const { client, projects } = makeClient([])
    const id = await resolveProjectId(client, 'acme', PROJECT_UUID)
    expect(id).toBe(PROJECT_UUID)
    expect(projects).not.toHaveBeenCalled()
  })

  it('Test 2: name lookup — case-insensitive, returns matching id with one bulk call', async () => {
    const { client, projects } = makeClient([
      { id: 'project-roadmap-id', name: 'Roadmap Q1' },
      { id: 'project-platform-id', name: 'Platform' },
    ])
    expect(await resolveProjectId(client, 'acme', 'Roadmap Q1')).toBe('project-roadmap-id')
    expect(await resolveProjectId(client, 'acme', 'roadmap q1')).toBe('project-roadmap-id')
    expect(projects).toHaveBeenCalledTimes(1)
  })

  it('Test 3: cache by workspace — repeated calls trigger ONE SDK call across N requests', async () => {
    const { client, projects } = makeClient([
      { id: 'project-roadmap-id', name: 'Roadmap Q1' },
      { id: 'project-platform-id', name: 'Platform' },
    ])
    await resolveProjectId(client, 'acme', 'Roadmap Q1')
    await resolveProjectId(client, 'acme', 'Platform')
    await resolveProjectId(client, 'acme', 'roadmap q1')
    expect(projects).toHaveBeenCalledTimes(1)
  })

  it('Test 4: miss — throws PROJECT_NOT_FOUND with workspace, requested, sorted available', async () => {
    const { client } = makeClient([
      { id: 'project-roadmap-id', name: 'Roadmap Q1' },
      { id: 'project-platform-id', name: 'Platform' },
    ])
    try {
      await resolveProjectId(client, 'acme', 'BogusProject')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('PROJECT_NOT_FOUND')
      expect(err.message).toMatch(/project not found: BogusProject/)
      expect(err.details).toEqual({
        workspace: 'acme',
        requested: 'BogusProject',
        available: ['platform', 'roadmap q1'],
      })
    }
  })
})
