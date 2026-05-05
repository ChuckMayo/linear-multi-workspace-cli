/**
 * `raw` oclif command tests (Phase 3 PLAN 03-02, RAW-01 / RAW-02).
 *
 * Tests call `runRaw` directly (the named re-export from the command file)
 * to avoid subprocess overhead — same test seam as `runIssueTransition` in
 * `test/commands/issue-list.test.ts`.
 *
 * Coverage:
 *   11. Command-level success: runRaw returns success envelope for a query op.
 *   12. Command metadata: enableJsonFlag=true, operation arg required, expected flags present.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Stub @linear/sdk BEFORE importing modules that consume it.
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
      client: { rawRequest: (q: string, vars: unknown) => Promise<unknown> }
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
        this.client = {
          rawRequest: async (q: string, vars: unknown) => {
            if (!mockRawRequestFn)
              throw new Error('mockRawRequestFn not configured')
            return mockRawRequestFn(q, vars)
          },
        }
      }
    },
  }
})

// Mock the operation registry
vi.mock('@/generated/operations.js', () => ({
  OPERATION_REGISTRY: {
    Issues: {
      kind: 'query',
      source: 'query Issues($first: Int) { issues(first: $first) { nodes { id title } } }',
      varsSchema: z.object({ first: z.number().int().optional() }),
    },
    IssueCreate: {
      kind: 'mutation',
      source:
        'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success } }',
      varsSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
    },
  },
}))

let mockRawRequestFn: ((q: string, vars: unknown) => Promise<unknown>) | undefined

import type { Config } from '@/core/config/index.js'
import RawCommand, { runRaw } from '@/commands/raw/index.js'

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

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  mockRawRequestFn = undefined
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  mockRawRequestFn = undefined
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

// -----------------------------------------------------------------------------
// Test 11: Command-level success (via runRaw)
// -----------------------------------------------------------------------------

describe('RawCommand — command-level success', () => {
  it('Test 11: runRaw with Issues query returns success envelope', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { issues: { nodes: [{ id: 'cmd-a', title: 'Command Test' }] } },
    })

    const out = await runRaw({
      args: { operation: 'Issues' },
      flags: { vars: '{"first":1}' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual({ issues: { nodes: [{ id: 'cmd-a', title: 'Command Test' }] } })
    expect(out.meta.workspace).toBe('acme')
    expect(out).toMatchSnapshot('cmd-success-query')
  })
})

// -----------------------------------------------------------------------------
// Test 12: oclif command metadata
// -----------------------------------------------------------------------------

describe('RawCommand — oclif metadata', () => {
  it('Test 12: enableJsonFlag=true, operation arg required, expected flags present', () => {
    expect(RawCommand.enableJsonFlag).toBe(true)
    const args = RawCommand.args as Record<string, { required?: boolean }>
    expect(args.operation?.required).toBe(true)
    const flagNames = Object.keys(RawCommand.flags)
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(flagNames).toContain('allow-mutations')
    expect(flagNames).toContain('vars')
    expect(flagNames).toContain('fields')
    expect(typeof runRaw).toBe('function')
  })
})
