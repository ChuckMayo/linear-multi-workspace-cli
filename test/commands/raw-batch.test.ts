/**
 * `raw batch` oclif command tests (Phase 3 PLAN 03-05, RAW-05).
 *
 * Invokes runRawBatch programmatically (the named re-export from the command
 * file) — same test seam as issue-list.test.ts, raw.test.ts, etc.
 *
 * Coverage:
 *   16. Command-level success: dry-run envelope snapshot.
 *   17. Command metadata: enableJsonFlag=true, expected flags present (plan required, dry-run default true).
 */
import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
            if (!mockRawRequestFn) throw new Error('mockRawRequestFn not configured')
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
    IssueUpdate: {
      kind: 'mutation',
      source:
        'mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      varsSchema: z.object({ id: z.string(), input: z.record(z.string(), z.unknown()) }),
    },
  },
}))

let mockRawRequestFn: ((q: string, vars: unknown) => Promise<unknown>) | undefined

import RawBatchCommand, { runRawBatch } from '@/commands/raw/batch.js'
import type { Config } from '@/core/config/index.js'

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

function writeTmp(content: string): string {
  const path = join(tmpdir(), `raw-batch-cmd-test-${randomBytes(8).toString('hex')}.json`)
  writeFileSync(path, content, 'utf8')
  return path
}

function cleanTmp(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
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
// Test 16: Command-level dry-run success snapshot
// -----------------------------------------------------------------------------

describe('RawBatchCommand — command-level dry-run (Test 16)', () => {
  it('runRawBatch with query plan returns dry-run envelope; matches snapshot', async () => {
    const tmpFile = writeTmp(JSON.stringify([{ operation: 'Issues', vars: { first: 2 } }]))
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          // dry-run default true
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      expect((out.data as Record<string, unknown>).plan).toBeDefined()
      const plan = (out.data as Record<string, unknown>).plan as Array<Record<string, unknown>>
      expect(plan[0]?.operation).toBe('Issues')
      expect(plan[0]?.kind).toBe('query')
      expect(out).toMatchSnapshot('cmd-dry-run-success')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 17: oclif command metadata
// -----------------------------------------------------------------------------

describe('RawBatchCommand — oclif metadata (Test 17)', () => {
  it('enableJsonFlag=true; plan flag required; dry-run defaults to true; expected flags present', () => {
    expect(RawBatchCommand.enableJsonFlag).toBe(true)
    const flagNames = Object.keys(RawBatchCommand.flags)
    expect(flagNames).toContain('workspace')
    expect(flagNames).toContain('allow-active-workspace-write')
    expect(flagNames).toContain('allow-mutations')
    expect(flagNames).toContain('plan')
    expect(flagNames).toContain('dry-run')
    expect(flagNames).toContain('yes')
    expect(typeof runRawBatch).toBe('function')

    // plan flag is required
    const planFlag = (RawBatchCommand.flags as Record<string, { required?: boolean }>).plan
    expect(planFlag?.required).toBe(true)

    // dry-run flag defaults to true
    const dryRunFlag = (RawBatchCommand.flags as Record<string, { default?: unknown }>)['dry-run']
    expect(dryRunFlag?.default).toBe(true)
  })
})
