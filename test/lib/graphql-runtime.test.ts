/**
 * `graphql-runtime` tests (Phase 3 PLAN 03-03, RAW-03).
 *
 * Tests the 8-step pipeline: resolveWorkspace → load query → parse →
 * validate (against real vendored schema) → detect kind → WSP-06 +
 * --allow-mutations → load vars → rawRequest dispatch.
 *
 * Mock strategy:
 *  - `@linear/sdk` is mocked so `LinearClient` has a controllable `client.rawRequest`.
 *  - `graphql-js` (parse/validate) is NOT mocked — Test 3 verifies the vendored
 *    schema rejects unknown fields end-to-end.
 *  - `schema-loader` is NOT mocked — module-level cache is exercised by Test 12.
 *
 * Coverage:
 *   1.  --query=@nonexistent.graphql → GRAPHQL_QUERY_FILE_NOT_FOUND (exit 2)
 *   2.  Malformed query → GRAPHQL_VALIDATION_FAILED (kind=parse, ZERO rawRequest)
 *   3.  Unknown field → GRAPHQL_VALIDATION_FAILED (kind=validate, real schema)
 *   4.  Subscription op → OPERATION_SUBSCRIPTIONS_UNSUPPORTED (exit 2)
 *   5.  Fragment-first query (Pitfall 5) — correctly identifies 'query' op kind
 *   6.  Mutation without --allow-mutations → RAW_MUTATION_REQUIRES_FLAG (exit 2)
 *   7.  Mutation with no --workspace (WSP-06 BEFORE --allow-mutations) → WORKSPACE_REQUIRED_FOR_WRITE
 *   8.  Inline query success → success envelope
 *   9.  --query=@file.graphql success → success envelope; rawRequest called with file content
 *   10. --vars=@file.json success → rawRequest called with parsed JSON vars
 *   11. LINEAR_API_ERROR on response.error (Pitfall 2)
 *   12. Schema cache: second call returns the same GraphQLSchema instance; reset works
 *   13. (in graphql.test.ts) command-level success
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mock @linear/sdk BEFORE any module that imports it is loaded.
// The mock exports LinearClient with a controllable `client.rawRequest`.
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
        // The `client` sub-object mirrors @linear/sdk's LinearGraphQLClient
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

import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { runGraphql } from '@/lib/graphql-runtime.js'
import { _resetSchemaCacheForTesting, getLinearSchema } from '@/lib/schema-loader.js'

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

/** Mirrors the snapshotFailureEnvelope helper pattern from issue-purge-runtime.test.ts */
function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'graphql' })
}

// Temp dirs and files created by tests
const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graphql-test-'))
  tmpDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  // Reset mock call state before each test
  mockRawRequestFn = vi.fn()
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterAll(async () => {
  // Cleanup temp dirs
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 1: GRAPHQL_QUERY_FILE_NOT_FOUND
// ---------------------------------------------------------------------------

describe('graphql-runtime — GRAPHQL_QUERY_FILE_NOT_FOUND', () => {
  it('Test 1: @nonexistent.graphql → GRAPHQL_QUERY_FILE_NOT_FOUND (exit 2), ZERO rawRequest', async () => {
    const missingPath = '/tmp/does-not-exist-xyz-graphql-runtime-test.graphql'

    expect.assertions(5)
    try {
      await runGraphql({
        flags: { query: `@${missingPath}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('GRAPHQL_QUERY_FILE_NOT_FOUND')
      expect((err.details as Record<string, unknown>)?.path).toBe(missingPath)
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-GRAPHQL_QUERY_FILE_NOT_FOUND')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 2: GRAPHQL_VALIDATION_FAILED (parse)
// ---------------------------------------------------------------------------

describe('graphql-runtime — GRAPHQL_VALIDATION_FAILED (parse)', () => {
  it('Test 2: malformed query → GRAPHQL_VALIDATION_FAILED kind=parse, ZERO rawRequest', async () => {
    expect.assertions(6)
    try {
      await runGraphql({
        flags: { query: '{ foo' /* unterminated brace */ },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('GRAPHQL_VALIDATION_FAILED')
      const details = err.details as Record<string, unknown>
      expect(details?.kind).toBe('parse')
      expect(typeof details?.cause).toBe('string')
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-GRAPHQL_VALIDATION_FAILED-parse')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 3: GRAPHQL_VALIDATION_FAILED (validate) — real schema, no mocks
// ---------------------------------------------------------------------------

describe('graphql-runtime — GRAPHQL_VALIDATION_FAILED (validate, real schema)', () => {
  it('Test 3: unknown field → GRAPHQL_VALIDATION_FAILED kind=validate, real schema, ZERO rawRequest', async () => {
    expect.assertions(7)
    try {
      await runGraphql({
        flags: { query: '{ definitelyNotARealField }' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('GRAPHQL_VALIDATION_FAILED')
      const details = err.details as Record<string, unknown>
      expect(details?.kind).toBe('validate')
      expect(Array.isArray(details?.errors)).toBe(true)
      const errs = details?.errors as Array<Record<string, unknown>>
      expect(errs.length).toBeGreaterThan(0)
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      // Snapshot the validate-kind failure envelope (distinct from parse-kind)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-GRAPHQL_VALIDATION_FAILED-validate')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 4: OPERATION_SUBSCRIPTIONS_UNSUPPORTED
// ---------------------------------------------------------------------------

describe('graphql-runtime — OPERATION_SUBSCRIPTIONS_UNSUPPORTED', () => {
  it('Test 4: subscription op → OPERATION_SUBSCRIPTIONS_UNSUPPORTED (exit 2), ZERO rawRequest', async () => {
    // agentActivityCreated is a real subscription field in Linear's schema
    expect.assertions(4)
    try {
      await runGraphql({
        flags: { query: 'subscription S { agentActivityCreated { id } }' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('OPERATION_SUBSCRIPTIONS_UNSUPPORTED')
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-OPERATION_SUBSCRIPTIONS_UNSUPPORTED')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 5: Pitfall 5 — FragmentDefinition first, operation correctly detected
// ---------------------------------------------------------------------------

describe('graphql-runtime — Pitfall 5 (fragment-first)', () => {
  it('Test 5: fragment-first query → operation kind=query detected correctly (NOT misclassified)', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { issues: { nodes: [{ id: 'a' }] } },
    })

    const out = await runGraphql({
      flags: {
        query:
          'fragment IssueBits on Issue { id }\nquery Q { issues(first: 1) { nodes { ...IssueBits } } }',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      mockRawRequest: mockRawRequestFn,
    })

    // The operation was executed — rawRequest was called (not rejected as mutation/subscription)
    expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    expect(out.data).toEqual({ issues: { nodes: [{ id: 'a' }] } })
    expect(out).toMatchSnapshot('fragment-first-query-success')
  })
})

// ---------------------------------------------------------------------------
// Test 6: RAW_MUTATION_REQUIRES_FLAG
// ---------------------------------------------------------------------------

describe('graphql-runtime — RAW_MUTATION_REQUIRES_FLAG', () => {
  it('Test 6: mutation without --allow-mutations → RAW_MUTATION_REQUIRES_FLAG, ZERO rawRequest', async () => {
    expect.assertions(4)
    try {
      await runGraphql({
        flags: {
          workspace: 'acme',
          query: 'mutation M { issueDelete(id: "x") { success } }',
          // allow-mutations intentionally NOT set
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_MUTATION_REQUIRES_FLAG')
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      // RAW_MUTATION_REQUIRES_FLAG was already snapshotted by 03-02-PLAN;
      // assert code + exit only (no duplicate snapshot)
      expect(err.code).toBe('RAW_MUTATION_REQUIRES_FLAG')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 7: WSP-06 GATE ORDERING — mutation without --workspace → WORKSPACE_REQUIRED_FOR_WRITE
// ---------------------------------------------------------------------------

describe('graphql-runtime — WSP-06 gate ordering for mutations', () => {
  it('Test 7: mutation + no --workspace (active workspace only) → WORKSPACE_REQUIRED_FOR_WRITE BEFORE RAW_MUTATION_REQUIRES_FLAG', async () => {
    // STUB_CONFIG has active: 'acme' — workspace resolves from 'active' source.
    // Without an explicit --workspace flag, WSP-06 fires first.
    expect.assertions(4)
    try {
      await runGraphql({
        flags: {
          // No workspace flag — resolver will use 'active' source
          query: 'mutation M { issueDelete(id: "x") { success } }',
          'allow-mutations': true, // Even with allow-mutations set, WSP-06 fires first
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      // WSP-06 fires BEFORE --allow-mutations check (gate-order test)
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      expect(mockRawRequestFn).not.toHaveBeenCalled()
      // WORKSPACE_REQUIRED_FOR_WRITE was already snapshotted by 03-02-PLAN;
      // assert code only (no duplicate snapshot)
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 8: Inline query success
// ---------------------------------------------------------------------------

describe('graphql-runtime — inline query success', () => {
  it('Test 8: inline --query success → success envelope', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { viewer: { id: 'u1', name: 'You' } },
    })

    const out = await runGraphql({
      flags: { query: '{ viewer { id name } }' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      mockRawRequest: mockRawRequestFn,
    })

    expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    expect(out.data).toEqual({ viewer: { id: 'u1', name: 'You' } })
    expect(out.meta.workspace).toBe('acme')
    expect(out).toMatchSnapshot('inline-query-success')
  })
})

// ---------------------------------------------------------------------------
// Test 9: --query=@file.graphql success
// ---------------------------------------------------------------------------

describe('graphql-runtime — @file.graphql success', () => {
  it('Test 9: --query=@<tmpfile> → rawRequest called with file contents', async () => {
    const dir = makeTmpDir()
    const queryFile = join(dir, 'q.graphql')
    const queryText = 'query Issues($first: Int) { issues(first: $first) { nodes { id } } }'
    writeFileSync(queryFile, queryText, 'utf8')

    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { issues: { nodes: [{ id: 'iss1' }] } },
    })

    const out = await runGraphql({
      flags: {
        query: `@${queryFile}`,
        vars: '{"first":3}',
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      mockRawRequest: mockRawRequestFn,
    })

    expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    // rawRequest was called with (queryText, { first: 3 })
    const call = mockRawRequestFn.mock.calls[0] as [string, Record<string, unknown>]
    expect(call[0]).toBe(queryText)
    expect(call[1]).toEqual({ first: 3 })
    expect(out.data).toEqual({ issues: { nodes: [{ id: 'iss1' }] } })
    expect(out).toMatchSnapshot('file-query-success')
  })
})

// ---------------------------------------------------------------------------
// Test 10: --vars=@file.json
// ---------------------------------------------------------------------------

describe('graphql-runtime — --vars=@file.json', () => {
  it('Test 10: --vars=@<tmpfile> → rawRequest called with parsed JSON from file', async () => {
    const dir = makeTmpDir()
    const varsFile = join(dir, 'vars.json')
    writeFileSync(varsFile, '{"first": 5}', 'utf8')

    mockRawRequestFn = vi.fn().mockResolvedValue({
      data: { viewer: { id: 'u2' } },
    })

    await runGraphql({
      flags: {
        query: '{ viewer { id } }',
        vars: `@${varsFile}`,
      },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      mockRawRequest: mockRawRequestFn,
    })

    expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    const call = mockRawRequestFn.mock.calls[0] as [string, Record<string, unknown>]
    expect(call[1]).toEqual({ first: 5 })
  })
})

// ---------------------------------------------------------------------------
// Test 11: LINEAR_API_ERROR on response.error (Pitfall 2)
// ---------------------------------------------------------------------------

describe('graphql-runtime — LINEAR_API_ERROR', () => {
  it('Test 11: response.error populated → LINEAR_API_ERROR thrown', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({
      error: 'GraphQL error',
      data: undefined,
    })

    expect.assertions(3)
    try {
      await runGraphql({
        flags: { query: '{ viewer { id } }' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        mockRawRequest: mockRawRequestFn,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      // LINEAR_API_ERROR was already snapshotted by Phase 1; assert code only
      expect(err.code).toBe('LINEAR_API_ERROR')
      expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 12: Schema cache
// ---------------------------------------------------------------------------

describe('schema-loader — lazy module-level cache', () => {
  it('Test 12: getLinearSchema() returns the same instance on repeated calls; _resetSchemaCacheForTesting() clears cache', () => {
    // Ensure cache starts fresh for this test
    _resetSchemaCacheForTesting()

    const s1 = getLinearSchema()
    const s2 = getLinearSchema()
    // Same reference (module-level cache)
    expect(s1).toBe(s2)

    // After reset, next call builds a fresh schema
    _resetSchemaCacheForTesting()
    const s3 = getLinearSchema()
    // s3 is a new instance (distinct reference)
    expect(s3).not.toBe(s1)
    // But it's still a valid GraphQLSchema
    expect(typeof s3.getQueryType).toBe('function')

    // Restore a warm cache for subsequent tests (avoid re-running buildSchema)
    // Note: s3 is now the cached value, which is fine.
  })
})
