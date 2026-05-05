/**
 * `rawRuntime` tests (Phase 3 PLAN 03-02, RAW-01 / RAW-02).
 *
 * Dispatches any operation in the generated GraphQL registry via
 * `client.client.rawRequest(entry.source, vars)`. Gated on:
 *   - WSP-06: `requireExplicitWorkspaceForWrite` fires BEFORE `--allow-mutations`
 *   - `--allow-mutations`: required for mutation-kind operations
 *   - `entry.kind === 'subscription'`: rejected defensively
 *
 * **Gate ordering is load-bearing (Test 3 — WSP-06 ordering):**
 *   1. resolveWorkspace
 *   2. registry lookup (RAW_OPERATION_NOT_FOUND on miss with closest-match suggestions)
 *   3. subscription guard (OPERATION_SUBSCRIPTIONS_UNSUPPORTED)
 *   4. requireExplicitWorkspaceForWrite (WSP-06 FIRST — precedent: issue-purge-runtime.ts:99 Test 11)
 *   5. --allow-mutations check (RAW_MUTATION_REQUIRES_FLAG)
 *   6. vars parse + Zod validation (RAW_VARS_INVALID)
 *   7. createLinearClient
 *   8. client.client.rawRequest(entry.source, vars) wrapped in transport
 *   9. response.error check → LINEAR_API_ERROR (Pitfall 2: STRING not LinearError)
 *   10. meta build + return envelope
 *
 * Coverage:
 *   1. RAW_OPERATION_NOT_FOUND with closest-match suggestions.
 *   2. RAW_MUTATION_REQUIRES_FLAG — mutation without --allow-mutations.
 *   3. WSP-06 gate ordering — mutation without --workspace fires WORKSPACE_REQUIRED_FOR_WRITE BEFORE RAW_MUTATION_REQUIRES_FLAG.
 *   4. RAW_VARS_INVALID (Zod validation).
 *   5. RAW_VARS_INVALID (JSON parse error).
 *   6. Success path (query) — rawRequest called once with correct args.
 *   7. Success path (mutation) — with explicit workspace + --allow-mutations.
 *   8. LINEAR_API_ERROR on response.error string (Pitfall 2).
 *   8b. OPERATION_SUBSCRIPTIONS_UNSUPPORTED — defensive guard.
 *   9. GRAPHQL_QUERY_FILE_NOT_FOUND on @nonexistent.json.
 *   10. --vars=@file.json file precedence — rawRequest called with file content.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Stub @linear/sdk BEFORE importing modules that consume it.
// Extend MockLinearClient with `client.rawRequest` for raw/graphql tests.
vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    complexityRemaining?: number
    complexityLimit?: number
    complexityResetAt?: number | Date
    constructor(opts?: {
      message?: string
      retryAfter?: number
      complexityRemaining?: number
      complexityLimit?: number
      complexityResetAt?: number | Date
    }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
      if (opts?.complexityRemaining !== undefined)
        this.complexityRemaining = opts.complexityRemaining
      if (opts?.complexityLimit !== undefined) this.complexityLimit = opts.complexityLimit
      if (opts?.complexityResetAt !== undefined) this.complexityResetAt = opts.complexityResetAt
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

// Mock the operation registry with a tiny fixture (3-5 ops covering query + mutation + edge cases)
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
    IssueDelete: {
      kind: 'mutation',
      source: 'mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }',
      varsSchema: z.object({ id: z.string() }),
    },
    MySub: {
      kind: 'subscription',
      source: 'subscription MySub { issueCreated { id } }',
      varsSchema: z.object({}),
    },
  },
}))

// mockRawRequestFn: set per-test to control what rawRequest returns
let mockRawRequestFn: ((q: string, vars: unknown) => Promise<unknown>) | undefined

import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { runRaw } from '@/lib/raw-runtime.js'

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

function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'raw' })
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
// Test 1: RAW_OPERATION_NOT_FOUND
// -----------------------------------------------------------------------------

describe('rawRuntime — RAW_OPERATION_NOT_FOUND', () => {
  it('Test 1: unknown operation → RAW_OPERATION_NOT_FOUND with closest-match suggestions', async () => {
    expect.assertions(6)
    try {
      await runRaw({
        args: { operation: 'NotARealOp' },
        flags: {},
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_OPERATION_NOT_FOUND')
      expect(exitCodeFor(err.code)).toBe(2)
      expect(Array.isArray((err.details as Record<string, unknown>)?.suggestions)).toBe(true)
      expect(
        ((err.details as Record<string, unknown>)?.suggestions as string[]).length,
      ).toBeLessThanOrEqual(3)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-RAW_OPERATION_NOT_FOUND')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 2: RAW_MUTATION_REQUIRES_FLAG
// -----------------------------------------------------------------------------

describe('rawRuntime — RAW_MUTATION_REQUIRES_FLAG', () => {
  it('Test 2: mutation without --allow-mutations → RAW_MUTATION_REQUIRES_FLAG', async () => {
    expect.assertions(3)
    try {
      await runRaw({
        args: { operation: 'IssueCreate' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_MUTATION_REQUIRES_FLAG')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-RAW_MUTATION_REQUIRES_FLAG')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 3: WSP-06 gate ordering (THE load-bearing test)
// Mirrors issue-purge-runtime.test.ts:99 Test 11.
// Without --workspace + with --allow-mutations → WORKSPACE_REQUIRED_FOR_WRITE (NOT RAW_MUTATION_REQUIRES_FLAG)
// -----------------------------------------------------------------------------

describe('rawRuntime — WSP-06 gate ordering', () => {
  it('Test 3: WSP-06 fires BEFORE --allow-mutations; no explicit workspace + allow-mutations:true → WORKSPACE_REQUIRED_FOR_WRITE', async () => {
    expect.assertions(3)
    try {
      // STUB_CONFIG has active workspace 'acme' — so workspace RESOLVES (source='active')
      // but WSP-06 should reject it before --allow-mutations fires
      await runRaw({
        args: { operation: 'IssueCreate' },
        flags: { 'allow-mutations': true }, // NO explicit workspace selector
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      // WSP-06 gate ordering: WORKSPACE_REQUIRED_FOR_WRITE, NOT RAW_MUTATION_REQUIRES_FLAG
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-WORKSPACE_REQUIRED_FOR_WRITE')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 4: RAW_VARS_INVALID (Zod validation failure)
// -----------------------------------------------------------------------------

describe('rawRuntime — RAW_VARS_INVALID (Zod)', () => {
  it('Test 4: --vars with wrong type fails Zod → RAW_VARS_INVALID with details.issues', async () => {
    // Issues op has varsSchema: z.object({ first: z.number().int().optional() })
    // Passing first as a string should fail Zod
    expect.assertions(5)
    try {
      await runRaw({
        args: { operation: 'Issues' },
        flags: { vars: '{"first":"not-a-number"}' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_VARS_INVALID')
      expect(exitCodeFor(err.code)).toBe(12)
      const issues = (err.details as Record<string, unknown>)?.issues
      expect(Array.isArray(issues) && (issues as unknown[]).length > 0).toBe(true)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-RAW_VARS_INVALID')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 5: RAW_VARS_INVALID (JSON parse error)
// -----------------------------------------------------------------------------

describe('rawRuntime — RAW_VARS_INVALID (parse error)', () => {
  it('Test 5: --vars with invalid JSON → RAW_VARS_INVALID with details.reason=parse_error', async () => {
    expect.assertions(3)
    try {
      await runRaw({
        args: { operation: 'Issues' },
        flags: { vars: '{not-valid-json' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_VARS_INVALID')
      expect((err.details as Record<string, unknown>)?.reason).toBe('parse_error')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 6: Success path (query)
// -----------------------------------------------------------------------------

describe('rawRuntime — success path (query)', () => {
  it('Test 6: Issues query returns success envelope; rawRequest called once with correct args', async () => {
    const rawRequestSpy = vi.fn().mockResolvedValue({
      data: { issues: { nodes: [{ id: 'a', title: 'T' }] } },
    })
    mockRawRequestFn = rawRequestSpy

    const out = await runRaw({
      args: { operation: 'Issues' },
      flags: { vars: '{"first":3}' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    // rawRequest called exactly once with the pre-printed source string + parsed vars
    expect(rawRequestSpy).toHaveBeenCalledTimes(1)
    const [calledSource, calledVars] = rawRequestSpy.mock.calls[0] as [string, unknown]
    expect(calledSource).toContain('query Issues')
    expect(calledVars).toEqual({ first: 3 })

    expect(out.data).toEqual({ issues: { nodes: [{ id: 'a', title: 'T' }] } })
    expect(out.meta.workspace).toBe('acme')
    expect(out).toMatchSnapshot('success-query-issues')
  })
})

// -----------------------------------------------------------------------------
// Test 7: Success path (mutation)
// -----------------------------------------------------------------------------

describe('rawRuntime — success path (mutation)', () => {
  it('Test 7: IssueCreate mutation with explicit workspace + allow-mutations returns success envelope', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { issueCreate: { success: true } },
    })

    const out = await runRaw({
      args: { operation: 'IssueCreate' },
      flags: {
        workspace: 'acme',
        'allow-mutations': true,
        vars: '{"input":{"title":"x","teamId":"t1"}}',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
    })

    expect(out.data).toEqual({ issueCreate: { success: true } })
    expect(out.meta.workspace).toBe('acme')
    expect(out).toMatchSnapshot('success-mutation-issueCreate')
  })
})

// -----------------------------------------------------------------------------
// Test 8: LINEAR_API_ERROR on response.error (Pitfall 2)
// rawRequest does NOT throw on GraphQL errors — populates response.error as STRING
// -----------------------------------------------------------------------------

describe('rawRuntime — LINEAR_API_ERROR (Pitfall 2)', () => {
  it('Test 8: response.error string → LINEAR_API_ERROR with details.cause', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      error: 'GraphQL error: Bad input',
    })

    expect.assertions(3)
    try {
      await runRaw({
        args: { operation: 'Issues' },
        flags: { vars: '{"first":1}' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect((err.details as Record<string, unknown>)?.cause).toBe('GraphQL error: Bad input')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 8b: OPERATION_SUBSCRIPTIONS_UNSUPPORTED (defensive guard)
// Even though real codegen excludes subscriptions, runtime must reject them defensively
// -----------------------------------------------------------------------------

describe('rawRuntime — OPERATION_SUBSCRIPTIONS_UNSUPPORTED', () => {
  it('Test 8b: subscription op → OPERATION_SUBSCRIPTIONS_UNSUPPORTED; zero rawRequest calls', async () => {
    const rawRequestSpy = vi.fn()
    mockRawRequestFn = rawRequestSpy

    expect.assertions(5)
    try {
      await runRaw({
        args: { operation: 'MySub' },
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('OPERATION_SUBSCRIPTIONS_UNSUPPORTED')
      expect(exitCodeFor(err.code)).toBe(2)
      expect(rawRequestSpy).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-OPERATION_SUBSCRIPTIONS_UNSUPPORTED')
    }
  })
})

// -----------------------------------------------------------------------------
// Test 9: GRAPHQL_QUERY_FILE_NOT_FOUND on @nonexistent.json
// -----------------------------------------------------------------------------

describe('rawRuntime — GRAPHQL_QUERY_FILE_NOT_FOUND', () => {
  it('Test 9: --vars=@nonexistent.json → GRAPHQL_QUERY_FILE_NOT_FOUND with details.path', async () => {
    const nonexistentPath = '/tmp/does-not-exist-xyz-abc-123.json'
    expect.assertions(4)
    try {
      await runRaw({
        args: { operation: 'Issues' },
        flags: { vars: `@${nonexistentPath}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('GRAPHQL_QUERY_FILE_NOT_FOUND')
      expect(exitCodeFor(err.code)).toBe(2)
      expect((err.details as Record<string, unknown>)?.path).toBe(nonexistentPath)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 10: --vars=@file.json file takes precedence
// -----------------------------------------------------------------------------

describe('rawRuntime — --vars=@file.json precedence', () => {
  it('Test 10: @file.json reads file content and passes to rawRequest', async () => {
    const tmpFile = join(tmpdir(), `raw-runtime-test-${Date.now()}.json`)
    writeFileSync(tmpFile, JSON.stringify({ first: 5 }), 'utf8')

    const rawRequestSpy = vi.fn().mockResolvedValue({
      data: { issues: { nodes: [] } },
    })
    mockRawRequestFn = rawRequestSpy

    try {
      await runRaw({
        args: { operation: 'Issues' },
        flags: { vars: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } finally {
      // cleanup tmpfile — fs.unlinkSync is fine here
      import('node:fs').then(({ unlinkSync }) => {
        try {
          unlinkSync(tmpFile)
        } catch {
          /* ignore */
        }
      })
    }

    expect(rawRequestSpy).toHaveBeenCalledTimes(1)
    const [, calledVars] = rawRequestSpy.mock.calls[0] as [string, unknown]
    expect(calledVars).toEqual({ first: 5 })
  })
})

// Import exitCodeFor for inline exit code checks
import { exitCodeFor } from '@/core/errors/index.js'
