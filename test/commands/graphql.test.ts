/**
 * `graphql` command tests (Phase 3 PLAN 03-03, RAW-03).
 *
 * Command-level test that verifies the oclif command surface and the
 * success envelope shape. Heavy pipeline testing is in
 * test/lib/graphql-runtime.test.ts.
 *
 * Test 13: command-level success snapshot.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @linear/sdk BEFORE any module that imports it is loaded.
// ---------------------------------------------------------------------------

let mockRawRequestFn: ReturnType<typeof vi.fn> = vi.fn()

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
      client: { rawRequest: ReturnType<typeof vi.fn> }
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
        this.client = {
          rawRequest: mockRawRequestFn,
        }
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Imports after mock setup
// ---------------------------------------------------------------------------

import GraphqlCommand, { runGraphql } from '@/commands/graphql/index.js'
import type { Config } from '@/core/config/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  mockRawRequestFn = vi.fn()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

// ---------------------------------------------------------------------------
// Test 13: command-level success
// ---------------------------------------------------------------------------

describe('GraphqlCommand oclif command surface', () => {
  it('Test 13: command has enableJsonFlag + required query flag + runGraphql export', () => {
    expect(GraphqlCommand.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(GraphqlCommand.flags)
    expect(flagNames).toContain('query')
    expect(flagNames).toContain('vars')
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-mutations')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(typeof runGraphql).toBe('function')
  })
})

describe('runGraphql — command-level success envelope', () => {
  it('Test 13b: success snapshot via runGraphql directly', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { viewer: { id: 'cmd-u1', name: 'Commander' } },
    })

    const out = await runGraphql({
      flags: { query: '{ viewer { id name } }' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      mockRawRequest: mockRawRequestFn,
    })

    expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    expect(out.data).toEqual({ viewer: { id: 'cmd-u1', name: 'Commander' } })
    expect(out.meta.workspace).toBe('acme')
    expect(out).toMatchSnapshot('graphql-command-success')
  })
})
