/**
 * `rawBatchRuntime` tests (Phase 3 PLAN 03-05, RAW-05).
 *
 * Safety-gated batch dispatcher: --dry-run by DEFAULT; --yes required to execute.
 * Gate ordering (Pitfall 7): WSP-06 fires AFTER plan validation but BEFORE any dispatch.
 * 100-entry cap (Pitfall 6): z.array(...).max(100).
 * Sequential dispatch (NOT parallel) — per-entry failures aggregated.
 *
 * Coverage:
 *   1. Dry-run default — ZERO rawRequest calls; data.plan populated.
 *   2. Execute path (--no-dry-run --yes) — rawRequest called per entry; data.results populated.
 *   3. BATCH_REQUIRES_YES — --no-dry-run without --yes → exit 2.
 *   4. --dry-run --yes both set → still dry-run (conservative; RESEARCH line 774).
 *   5. BATCH_PLAN_INVALID (malformed JSON) — canonical failure-envelope snapshot.
 *   6. BATCH_PLAN_INVALID (missing operation field) — details.entry_index === 0.
 *   7. BATCH_PLAN_INVALID (unknown operation) — details.entry_index + details.reason.
 *   8. BATCH_PLAN_INVALID (>100 entries cap, Pitfall 6).
 *   9. BATCH_PLAN_INVALID (empty array, min(1)).
 *   10. WSP-06 ordering (Pitfall 7) — mutation plan + missing workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE dispatch.
 *   11. Query-only plan does NOT require WSP-06.
 *   12. RAW_MUTATION_REQUIRES_FLAG — --workspace set, no --allow-mutations.
 *   13. Per-entry partial failure — top-level ok:true; failed row has ok:false.
 *   14. Sequential dispatch (NOT parallel) — timestamps strictly increasing.
 *   15. --plan without @ prefix → BATCH_PLAN_INVALID.
 *   16 (raw-batch.test.ts). Command-level dry-run snapshot.
 */
import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Stub @linear/sdk BEFORE importing modules that consume it.
// Extend MockLinearClient with `client.rawRequest` for raw/batch tests.
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
            if (!mockRawRequestFn) throw new Error('mockRawRequestFn not configured')
            return mockRawRequestFn(q, vars)
          },
        }
      }
    },
  }
})

// Mock the operation registry with a tiny fixture covering query + mutation
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
    IssueDelete: {
      kind: 'mutation',
      source: 'mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }',
      varsSchema: z.object({ id: z.string() }),
    },
  },
}))

// mockRawRequestFn: set per-test to control what rawRequest returns
let mockRawRequestFn: ((q: string, vars: unknown) => Promise<unknown>) | undefined

import type { Config } from '@/core/config/index.js'
import { exitCodeFor, LinearAgentError } from '@/core/errors/index.js'
import { failure } from '@/core/output/index.js'
import { runRawBatch } from '@/lib/raw-batch-runtime.js'

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

/** Mirror of issue-purge-runtime.test.ts:141-143 pattern */
function snapshotFailureEnvelope(err: LinearAgentError): unknown {
  return failure(err, { command: 'raw batch' })
}

/** Create a tmpfile with given content; returns the path. */
function writeTmp(content: string): string {
  const path = join(tmpdir(), `raw-batch-test-${randomBytes(8).toString('hex')}.json`)
  writeFileSync(path, content, 'utf8')
  return path
}

/** Clean up a tmpfile (ignore errors). */
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
// Test 1: Dry-run default — ZERO rawRequest calls; data.plan populated
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — dry-run default (Test 1)', () => {
  it('returns dry-run envelope with data.plan; ZERO rawRequest calls; no data.results', async () => {
    const rawRequestSpy = vi.fn()
    mockRawRequestFn = rawRequestSpy

    const tmpFile = writeTmp(
      JSON.stringify([
        { operation: 'IssueUpdate', vars: { id: 'a', input: { stateId: 'state-x' } } },
      ]),
    )
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          'allow-mutations': true,
          // dry-run is default true — NOT passing it explicitly
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // data.plan is present with 1 entry
      expect(Array.isArray((out.data as Record<string, unknown>).plan)).toBe(true)
      const plan = (out.data as Record<string, unknown>).plan as Array<Record<string, unknown>>
      expect(plan).toHaveLength(1)
      expect(plan[0]?.operation).toBe('IssueUpdate')
      expect(plan[0]?.kind).toBe('mutation')
      expect(plan[0]?.workspace).toBe('acme')

      // data.results is NOT present
      expect((out.data as Record<string, unknown>).results).toBeUndefined()

      // meta.batch present
      const meta = out.meta as Record<string, unknown>
      expect(meta.batch).toEqual({ count: 1, kinds: { query: 0, mutation: 1 } })

      // ZERO rawRequest calls
      expect(rawRequestSpy).not.toHaveBeenCalled()

      expect(out).toMatchSnapshot('dry-run-success')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 2: Execute path (--no-dry-run --yes)
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — execute path (Test 2)', () => {
  it('--dry-run false --yes → data.results array; rawRequest called once', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } })

    const tmpFile = writeTmp(
      JSON.stringify([
        { operation: 'IssueUpdate', vars: { id: 'a', input: { stateId: 'state-x' } } },
      ]),
    )
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          'allow-mutations': true,
          'dry-run': false,
          yes: true,
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // data.results present
      const results = (out.data as Record<string, unknown>).results as Array<
        Record<string, unknown>
      >
      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(1)
      expect(results[0]?.ok).toBe(true)
      expect(results[0]?.operation).toBe('IssueUpdate')
      expect(results[0]?.data).toBeDefined()

      // data.plan is NOT present
      expect((out.data as Record<string, unknown>).plan).toBeUndefined()

      // rawRequest called exactly once
      expect(mockRawRequestFn).toHaveBeenCalledTimes(1)

      // meta.batch present
      const meta = out.meta as Record<string, unknown>
      expect(meta.batch).toEqual({ count: 1, kinds: { query: 0, mutation: 1 } })

      expect(out).toMatchSnapshot('execute-success')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 3: BATCH_REQUIRES_YES — --no-dry-run without --yes → exit 2
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_REQUIRES_YES (Test 3)', () => {
  it('--dry-run false without --yes → BATCH_REQUIRES_YES (exit 2)', async () => {
    const tmpFile = writeTmp(JSON.stringify([{ operation: 'Issues', vars: { first: 1 } }]))
    expect.assertions(4)
    try {
      await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          'dry-run': false,
          // no --yes
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_REQUIRES_YES')
      expect(exitCodeFor(err.code)).toBe(2)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-BATCH_REQUIRES_YES')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 4: --dry-run --yes both set → still dry-run (RESEARCH line 774)
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — dry-run + yes precedence (Test 4)', () => {
  it('Both --dry-run and --yes → still returns dry-run envelope; ZERO rawRequest calls', async () => {
    const rawRequestSpy = vi.fn()
    mockRawRequestFn = rawRequestSpy

    const tmpFile = writeTmp(
      JSON.stringify([{ operation: 'IssueUpdate', vars: { id: 'b', input: {} } }]),
    )
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          'allow-mutations': true,
          'dry-run': true,
          yes: true,
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // dry-run envelope: data.plan present, data.results absent
      expect((out.data as Record<string, unknown>).plan).toBeDefined()
      expect((out.data as Record<string, unknown>).results).toBeUndefined()

      // ZERO rawRequest calls (--dry-run takes precedence over --yes)
      expect(rawRequestSpy).not.toHaveBeenCalled()
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 5: BATCH_PLAN_INVALID (malformed JSON) — canonical failure snapshot
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_PLAN_INVALID (malformed JSON) (Test 5)', () => {
  it('malformed JSON plan → BATCH_PLAN_INVALID (exit 12); canonical failure-envelope snapshot', async () => {
    const tmpFile = writeTmp('not-valid-json{')
    expect.assertions(4)
    try {
      await runRawBatch({
        flags: { plan: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
      expect(exitCodeFor(err.code)).toBe(12)
      // Canonical snapshot for BATCH_PLAN_INVALID envelope shape
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-BATCH_PLAN_INVALID')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 6: BATCH_PLAN_INVALID (missing operation field) — details.entry_index === 0
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_PLAN_INVALID (missing operation) (Test 6)', () => {
  it('[{"vars":{}}] — BATCH_PLAN_INVALID with details.entry_index === 0', async () => {
    const tmpFile = writeTmp(JSON.stringify([{ vars: {} }]))
    expect.assertions(3)
    try {
      await runRawBatch({
        flags: { plan: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
      expect((err.details as Record<string, unknown>)?.entry_index).toBe(0)
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 7: BATCH_PLAN_INVALID (unknown operation) — details.entry_index + details.reason
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_PLAN_INVALID (unknown operation) (Test 7)', () => {
  it('[{"operation":"NotARealOp","vars":{}}] → BATCH_PLAN_INVALID with entry_index 0', async () => {
    const tmpFile = writeTmp(JSON.stringify([{ operation: 'NotARealOp', vars: {} }]))
    expect.assertions(4)
    try {
      await runRawBatch({
        flags: { plan: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
      expect((err.details as Record<string, unknown>)?.entry_index).toBe(0)
      const reason = (err.details as Record<string, unknown>)?.reason as string
      expect(reason).toContain('NotARealOp')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 8: BATCH_PLAN_INVALID (>100 entries cap, Pitfall 6)
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_PLAN_INVALID (>100 entries, Pitfall 6) (Test 8)', () => {
  it('101 entries → BATCH_PLAN_INVALID; details mentions the 100-entry cap', async () => {
    // Generate 101 entries — all valid ops to hit the max(100) cap
    const entries = Array.from({ length: 101 }, () => ({ operation: 'Issues', vars: { first: 1 } }))
    const tmpFile = writeTmp(JSON.stringify(entries))
    expect.assertions(3)
    try {
      await runRawBatch({
        flags: { plan: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
      // Details should mention the cap (100)
      const details = err.details as Record<string, unknown>
      const reasonStr = JSON.stringify(details)
      expect(reasonStr).toMatch(/100/)
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 9: BATCH_PLAN_INVALID (empty array, min(1))
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — BATCH_PLAN_INVALID (empty array) (Test 9)', () => {
  it('[] → BATCH_PLAN_INVALID (z.array min(1))', async () => {
    const tmpFile = writeTmp('[]')
    expect.assertions(2)
    try {
      await runRawBatch({
        flags: { plan: `@${tmpFile}` },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 10: WSP-06 ordering (Pitfall 7)
// Mutation plan + missing workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any dispatch
// Snapshot: failure-WORKSPACE_REQUIRED_FOR_WRITE-batch (suffix distinguishes from 03-02's single-op case)
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — WSP-06 ordering, Pitfall 7 (Test 10)', () => {
  it('mutation plan + no --workspace → WORKSPACE_REQUIRED_FOR_WRITE BEFORE any rawRequest call', async () => {
    const rawRequestSpy = vi.fn()
    mockRawRequestFn = rawRequestSpy

    // Mutation plan with active workspace in config but no explicit --workspace
    const tmpFile = writeTmp(
      JSON.stringify([{ operation: 'IssueUpdate', vars: { id: 'x', input: {} } }]),
    )
    expect.assertions(4)
    try {
      await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          'allow-mutations': true,
          // NO explicit --workspace — WSP-06 should fire
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      // WSP-06 gate ordering (Pitfall 7): WORKSPACE_REQUIRED_FOR_WRITE, NOT RAW_MUTATION_REQUIRES_FLAG
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      // ZERO rawRequest calls — WSP-06 fires BEFORE any dispatch
      expect(rawRequestSpy).not.toHaveBeenCalled()
      // Snapshot the failure envelope (suffix -batch distinguishes from 03-02's single-op WSP-06 case)
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot(
        'failure-WORKSPACE_REQUIRED_FOR_WRITE-batch',
      )
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 11: Query-only plan does NOT require WSP-06
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — query-only plan, no WSP-06 (Test 11)', () => {
  it('query-only plan + dry-run + no --workspace → success (reads use active default)', async () => {
    const tmpFile = writeTmp(JSON.stringify([{ operation: 'Issues', vars: { first: 3 } }]))
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          // NO explicit --workspace — query-only should NOT require WSP-06
          // dry-run is default true
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // Should succeed as dry-run (no WSP-06 for query-only)
      expect((out.data as Record<string, unknown>).plan).toBeDefined()
      const plan = (out.data as Record<string, unknown>).plan as Array<Record<string, unknown>>
      expect(plan[0]?.kind).toBe('query')
    } finally {
      cleanTmp(tmpFile)
    }
  })

  it('query-only plan + --no-dry-run --yes + no --workspace → dispatches via active default', async () => {
    mockRawRequestFn = vi.fn().mockResolvedValue({ data: { issues: { nodes: [] } } })

    const tmpFile = writeTmp(JSON.stringify([{ operation: 'Issues', vars: { first: 1 } }]))
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          'dry-run': false,
          yes: true,
          // NO explicit --workspace — query-only should work with active default
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // data.results present
      const results = (out.data as Record<string, unknown>).results as Array<
        Record<string, unknown>
      >
      expect(Array.isArray(results)).toBe(true)
      expect(results[0]?.ok).toBe(true)
      // rawRequest was called
      expect(mockRawRequestFn).toHaveBeenCalledTimes(1)
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 12: RAW_MUTATION_REQUIRES_FLAG — workspace set, no --allow-mutations
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — RAW_MUTATION_REQUIRES_FLAG (Test 12)', () => {
  it('mutation plan + --workspace set + no --allow-mutations + execute → RAW_MUTATION_REQUIRES_FLAG; ZERO rawRequest calls', async () => {
    const rawRequestSpy = vi.fn()
    mockRawRequestFn = rawRequestSpy

    const tmpFile = writeTmp(
      JSON.stringify([{ operation: 'IssueUpdate', vars: { id: 'x', input: {} } }]),
    )
    expect.assertions(3)
    try {
      await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          // NO --allow-mutations
          'dry-run': false,
          yes: true,
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('RAW_MUTATION_REQUIRES_FLAG')
      expect(rawRequestSpy).not.toHaveBeenCalled()
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 13: Per-entry partial failure aggregation
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — per-entry partial failure (Test 13)', () => {
  it('entry 0 succeeds, entry 1 fails → top-level ok:true; results[0].ok=true, results[1].ok=false', async () => {
    let callCount = 0
    mockRawRequestFn = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        return { data: { issueUpdate: { success: true } } }
      }
      // Simulate a real LinearAgentError-like throw from the runtime
      throw Object.assign(new Error('ISSUE_NOT_FOUND: issue not found'), {
        code: 'ISSUE_NOT_FOUND',
      })
    })

    const plan = [
      { operation: 'IssueUpdate', vars: { id: 'a', input: {} } },
      { operation: 'IssueDelete', vars: { id: 'b-does-not-exist' } },
    ]
    const tmpFile = writeTmp(JSON.stringify(plan))
    try {
      const out = await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          'allow-mutations': true,
          'dry-run': false,
          yes: true,
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // Top-level ok:true (batch ran)
      const results = (out.data as Record<string, unknown>).results as Array<
        Record<string, unknown>
      >
      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(2)

      // Entry 0: succeeded
      expect(results[0]?.ok).toBe(true)
      expect(results[0]?.operation).toBe('IssueUpdate')

      // Entry 1: failed
      expect(results[1]?.ok).toBe(false)
      expect(results[1]?.operation).toBe('IssueDelete')
      expect(results[1]?.error).toBeDefined()

      // meta.batch present
      const meta = out.meta as Record<string, unknown>
      expect(meta.batch).toEqual({ count: 2, kinds: { query: 0, mutation: 2 } })

      expect(out).toMatchSnapshot('partial-failure-success')
    } finally {
      cleanTmp(tmpFile)
    }
  })
})

// -----------------------------------------------------------------------------
// Test 14: Sequential dispatch (NOT parallel) — timestamps strictly increasing
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — sequential dispatch (NOT parallel) (Test 14)', () => {
  it('sequential dispatch: call timestamps are strictly increasing (gap >= ~20ms per call)', async () => {
    const callTimestamps: number[] = []
    mockRawRequestFn = async () => {
      const start = Date.now()
      callTimestamps.push(start)
      // Small delay to make ordering measurable
      await new Promise<void>((r) => setTimeout(r, 20))
      return { data: { issueUpdate: { success: true } } }
    }

    const plan = [
      { operation: 'IssueUpdate', vars: { id: 'a', input: {} } },
      { operation: 'IssueUpdate', vars: { id: 'b', input: {} } },
      { operation: 'IssueUpdate', vars: { id: 'c', input: {} } },
    ]
    const tmpFile = writeTmp(JSON.stringify(plan))
    try {
      await runRawBatch({
        flags: {
          plan: `@${tmpFile}`,
          workspace: 'acme',
          'allow-mutations': true,
          'dry-run': false,
          yes: true,
        },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })

      // 3 entries → 3 rawRequest calls
      expect(callTimestamps).toHaveLength(3)

      // Sequential: each call's start time >= previous call's start + ~20ms delay
      // (This would NOT hold for parallel dispatch — they'd all start at ~the same time)
      for (let i = 1; i < callTimestamps.length; i++) {
        const gap = (callTimestamps[i] ?? 0) - (callTimestamps[i - 1] ?? 0)
        // Each sequential call must start at least ~15ms after the previous (allowing for timer imprecision)
        expect(gap).toBeGreaterThanOrEqual(15)
      }
    } finally {
      cleanTmp(tmpFile)
    }
  }, 10_000) // 10s timeout for the delay-based test
})

// -----------------------------------------------------------------------------
// Test 15: --plan without @ prefix → BATCH_PLAN_INVALID
// -----------------------------------------------------------------------------

describe('rawBatchRuntime — --plan without @ prefix (Test 15)', () => {
  it('inline-not-a-file (no @ prefix) → BATCH_PLAN_INVALID with @ requirement in details.reason', async () => {
    expect.assertions(3)
    try {
      await runRawBatch({
        flags: { plan: 'inline-not-a-file' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('BATCH_PLAN_INVALID')
      const reason = (err.details as Record<string, unknown>)?.reason as string
      expect(reason).toMatch(/@/)
    }
  })
})
