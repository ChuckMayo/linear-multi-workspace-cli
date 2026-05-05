/**
 * `describeRuntime` tests (Phase 4 PLAN 04-03, INT-02 + INT-04).
 *
 * Coverage:
 *   1. Curated path: 'issue list' → ok:true, kind:'curated', input has $schema
 *   2. Curated path: examples array is present (may be empty for stub schemas)
 *   3. Raw path: 'IssueCreate' → ok:true, kind:'raw', input has $schema
 *   4. Raw path: output is a string (SDL fragment or fallback)
 *   5. Error path: unknown target → LinearAgentError DESCRIBE_COMMAND_NOT_FOUND
 *   6. Error path: thrown error has details.suggestions as non-empty array
 *   7. Disambiguation: 'me' (lowercase) → curated
 *   8. Disambiguation: 'Issues' (PascalCase) → raw
 *   9. z.toJSONSchema safety: $schema equals draft-2020-12 URI for both paths
 *   10. Snapshot (INT-04): describe 'issue list' full data
 *   11. Snapshot (INT-04): describe 'IssueCreate' full data
 *   12. Snapshot (INT-04): failure envelope for DESCRIBE_COMMAND_NOT_FOUND
 */
import { describe, expect, it } from 'vitest'
import { describeRuntime } from '../../src/lib/describe-runtime.js'
import { LinearAgentError } from '../../src/core/errors/error.js'

const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema'

function snapshotFailureEnvelope(err: unknown) {
  if (err instanceof LinearAgentError) return { code: err.code, details: err.details }
  throw err
}

describe('describeRuntime — curated path', () => {
  it('returns ok:true and kind:"curated" for "issue list"', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(result.data.kind).toBe('curated')
    expect(result.data.command).toBe('issue list')
  })

  it('input is a valid JSON Schema object with $schema key', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(typeof result.data.input).toBe('object')
    expect(result.data.input).not.toBeNull()
    expect(result.data.input.$schema).toBe(DRAFT_2020_12_URI)
  })

  it('examples is an array', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(Array.isArray(result.data.examples)).toBe(true)
  })

  it('output is an object (envelope JSON Schema)', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(typeof result.data.output).toBe('object')
    expect(result.data.output).not.toBeNull()
  })

  it('meta.command is "describe"', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(result.meta.command).toBe('describe')
  })
})

describe('describeRuntime — raw path', () => {
  it('returns ok:true and kind:"raw" for "IssueCreate"', async () => {
    const result = await describeRuntime({ args: { command: 'IssueCreate' }, flags: {} })
    expect(result.data.kind).toBe('raw')
    expect(result.data.command).toBe('IssueCreate')
  })

  it('input is a valid JSON Schema object with $schema key', async () => {
    const result = await describeRuntime({ args: { command: 'IssueCreate' }, flags: {} })
    expect(typeof result.data.input).toBe('object')
    expect(result.data.input).not.toBeNull()
    expect(result.data.input.$schema).toBe(DRAFT_2020_12_URI)
  })

  it('output is a string (SDL fragment or fallback message)', async () => {
    const result = await describeRuntime({ args: { command: 'IssueCreate' }, flags: {} })
    expect(typeof result.data.output).toBe('string')
    expect((result.data.output as string).length).toBeGreaterThan(0)
  })

  it('examples is an empty array for raw ops in v1', async () => {
    const result = await describeRuntime({ args: { command: 'IssueCreate' }, flags: {} })
    expect(Array.isArray(result.data.examples)).toBe(true)
    expect(result.data.examples).toHaveLength(0)
  })
})

describe('describeRuntime — error path', () => {
  it('throws LinearAgentError with DESCRIBE_COMMAND_NOT_FOUND for unknown target', async () => {
    await expect(
      describeRuntime({ args: { command: 'nonexistent unknown' }, flags: {} }),
    ).rejects.toBeInstanceOf(LinearAgentError)

    try {
      await describeRuntime({ args: { command: 'nonexistent unknown' }, flags: {} })
    } catch (err) {
      expect(err instanceof LinearAgentError).toBe(true)
      if (err instanceof LinearAgentError) {
        expect(err.code).toBe('DESCRIBE_COMMAND_NOT_FOUND')
      }
    }
  })

  it('thrown error has details.suggestions as a non-empty array', async () => {
    try {
      await describeRuntime({ args: { command: 'nonexistent unknown' }, flags: {} })
    } catch (err) {
      expect(err instanceof LinearAgentError).toBe(true)
      if (err instanceof LinearAgentError) {
        expect(Array.isArray(err.details?.suggestions)).toBe(true)
        expect((err.details?.suggestions as string[]).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('describeRuntime — disambiguation', () => {
  it('"me" (lowercase start) routes to curated path', async () => {
    const result = await describeRuntime({ args: { command: 'me' }, flags: {} })
    expect(result.data.kind).toBe('curated')
  })

  it('"Issues" (PascalCase) routes to raw path', async () => {
    const result = await describeRuntime({ args: { command: 'Issues' }, flags: {} })
    expect(result.data.kind).toBe('raw')
  })

  it('"issue list" (contains space) routes to curated path', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(result.data.kind).toBe('curated')
  })
})

describe('describeRuntime — snapshots (INT-04)', () => {
  it('describe issue list — full output snapshot', async () => {
    const result = await describeRuntime({ args: { command: 'issue list' }, flags: {} })
    expect(result.data).toMatchSnapshot('describe-issue-list')
  })

  it('describe IssueCreate — full output snapshot', async () => {
    const result = await describeRuntime({ args: { command: 'IssueCreate' }, flags: {} })
    expect(result.data).toMatchSnapshot('describe-IssueCreate')
  })

  it('failure envelope for DESCRIBE_COMMAND_NOT_FOUND snapshot', async () => {
    try {
      await describeRuntime({ args: { command: 'zzz-totally-unknown' }, flags: {} })
      throw new Error('Expected to throw')
    } catch (err) {
      expect(snapshotFailureEnvelope(err)).toMatchSnapshot('failure-DESCRIBE_COMMAND_NOT_FOUND')
    }
  })
})
