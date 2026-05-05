/**
 * schema-runtime tests (Phase 4 PLAN 04-04, INT-03, INT-04).
 *
 * Coverage:
 *   1. Default: compact SDL (descriptions stripped), no `"""` in output
 *   2. Default: contains core Linear types (e.g. `type Issue {`)
 *   3. Default: verified counts — types_count=1081, queries=151, mutations=351, subscriptions=75
 *   4. --full: SDL includes `"""` (descriptions present)
 *   5. --full: compact SDL length < full SDL length
 *   6. --json: data.schema is an object with __schema key
 *   7. --json: queryType.name is "Query"
 *   8. --json: types array is non-empty
 *   9. --json: descriptions NOT present by default (descriptions: false)
 *   10. INT-04 snapshot: head + tail + counts (compact SDL)
 *   11. INT-04 snapshot: counts + first 3 type names (schema --json)
 */
import { describe, expect, it } from 'vitest'
import { schemaRuntime } from '../../src/lib/schema-runtime.js'

/** Minimal shape of the introspection __schema object we rely on in tests. */
interface IntrospectionSchemaShape {
  __schema: {
    queryType: { name: string }
    types: Array<{ name: string; description: string | null }>
  }
}

describe('schemaRuntime (compact SDL — default)', () => {
  it('returns a `data` object (envelope wrapping is the kernel’s job)', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data).toBeDefined()
    expect(typeof result.data).toBe('object')
  })

  it('data.schema is a non-empty string without triple-quoted descriptions', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(typeof result.data.schema).toBe('string')
    expect((result.data.schema as string).length).toBeGreaterThan(0)
    expect(result.data.schema).not.toContain('"""')
  })

  it('data.schema contains core Linear type "type Issue implements Node {"', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data.schema).toContain('type Issue implements Node {')
  })

  it('data.types_count is 1081', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data.types_count).toBe(1081)
  })

  it('data.queries_count is 151', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data.queries_count).toBe(151)
  })

  it('data.mutations_count is 351', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data.mutations_count).toBe(351)
  })

  it('data.subscriptions_count is 75', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result.data.subscriptions_count).toBe(75)
  })

  it('returns only `data` — meta.command is injected by runCommand', async () => {
    const result = await schemaRuntime({ flags: {} })
    expect(result).not.toHaveProperty('meta')
    expect(result).toHaveProperty('data')
  })
})

describe('schemaRuntime (--full flag)', () => {
  it('data.schema includes triple-quoted descriptions', async () => {
    const result = await schemaRuntime({ flags: { full: true } })
    expect(result.data.schema).toContain('"""')
  })

  it('compact SDL length < full SDL length', async () => {
    const compact = await schemaRuntime({ flags: {} })
    const full = await schemaRuntime({ flags: { full: true } })
    expect((compact.data.schema as string).length).toBeLessThan((full.data.schema as string).length)
  })
})

describe('schemaRuntime (--json flag)', () => {
  it('data.schema is an object with __schema key', async () => {
    const result = await schemaRuntime({ flags: { json: true } })
    expect(typeof result.data.schema).toBe('object')
    expect(result.data.schema).toHaveProperty('__schema')
  })

  it('data.schema.__schema.queryType.name is "Query"', async () => {
    const result = await schemaRuntime({ flags: { json: true } })
    expect((result.data.schema as IntrospectionSchemaShape).__schema.queryType.name).toBe('Query')
  })

  it('data.schema.__schema.types is a non-empty array', async () => {
    const result = await schemaRuntime({ flags: { json: true } })
    const types = (result.data.schema as IntrospectionSchemaShape).__schema.types
    expect(Array.isArray(types)).toBe(true)
    expect(types.length).toBeGreaterThan(0)
  })

  it('descriptions are NOT present by default (descriptions: false)', async () => {
    const result = await schemaRuntime({ flags: { json: true } })
    const types = (result.data.schema as IntrospectionSchemaShape).__schema.types
    // All type descriptions should be null or empty when descriptions: false
    const withDescriptions = types.filter((t) => t.description && t.description.length > 0)
    expect(withDescriptions).toHaveLength(0)
  })
})

describe('INT-04 snapshots', () => {
  it('schema — head + tail + counts', async () => {
    const result = await schemaRuntime({ flags: {} })
    const lines = (result.data.schema as string).split('\n').filter((l) => l.trim())
    expect({
      types_count: result.data.types_count,
      queries_count: result.data.queries_count,
      mutations_count: result.data.mutations_count,
      subscriptions_count: result.data.subscriptions_count,
      head: lines.slice(0, 10),
      tail: lines.slice(-10),
    }).toMatchSnapshot('schema-compact-head-tail-counts')
  })

  it('schema --json — counts + first 3 type names', async () => {
    const result = await schemaRuntime({ flags: { json: true } })
    const introspection = (result.data.schema as IntrospectionSchemaShape).__schema
    expect({
      types_count: result.data.types_count,
      queryType: introspection.queryType.name,
      first3Types: introspection.types.slice(0, 3).map((t) => t.name),
    }).toMatchSnapshot('schema-json-counts-first3')
  })
})
