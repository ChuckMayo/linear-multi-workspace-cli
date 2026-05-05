/**
 * list-tools runtime tests (Phase 4 PLAN 04-02, INT-01).
 *
 * Coverage:
 *   1. listToolsRuntime returns a success envelope with ok: true
 *   2. data.curated.length equals CURATED_REGISTRY.length
 *   3. data.raw.length equals getRawRegistryView().length
 *   4. data.counts.curated equals data.curated.length
 *   5. data.counts.raw equals data.raw.length
 *   6. data.curated is sorted alphabetically by id
 *   7. data.raw is sorted alphabetically by name
 *   8. Every curated entry with raw_equivalent resolves to an OPERATION_REGISTRY key
 *   9. No curated entry has raw_equivalent: null (must be string or omitted)
 *   10. INT-04 snapshot: data field snapshotted in full
 */
import { describe, expect, it } from 'vitest'
import { CURATED_REGISTRY, getRawRegistryView } from '../../src/lib/introspection-registry.js'
import { OPERATION_REGISTRY } from '../../src/generated/operations.js'
import { listToolsRuntime } from '../../src/lib/list-tools-runtime.js'

describe('listToolsRuntime', () => {
  it('returns a success envelope with ok: true', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result).toMatchObject({ ok: true })
  })

  it('data.curated.length equals CURATED_REGISTRY.length', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.data.curated.length).toBe(CURATED_REGISTRY.length)
  })

  it('data.raw.length equals getRawRegistryView().length', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.data.raw.length).toBe(getRawRegistryView().length)
  })

  it('data.counts.curated equals data.curated.length', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.data.counts.curated).toBe(result.data.curated.length)
  })

  it('data.counts.raw equals data.raw.length', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.data.counts.raw).toBe(result.data.raw.length)
  })

  it('data.curated is sorted alphabetically by id', async () => {
    const result = await listToolsRuntime({ flags: {} })
    const ids = result.data.curated.map((e) => e.id)
    const sorted = [...ids].sort((a, b) => a.localeCompare(b))
    expect(ids).toEqual(sorted)
  })

  it('data.raw is sorted alphabetically by name', async () => {
    const result = await listToolsRuntime({ flags: {} })
    const names = result.data.raw.map((e) => e.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  it('every curated entry with raw_equivalent resolves to an OPERATION_REGISTRY key', async () => {
    const result = await listToolsRuntime({ flags: {} })
    for (const entry of result.data.curated) {
      if (entry.raw_equivalent !== undefined) {
        expect(
          Object.prototype.hasOwnProperty.call(OPERATION_REGISTRY, entry.raw_equivalent),
          `raw_equivalent "${entry.raw_equivalent}" (entry: ${entry.id}) is not in OPERATION_REGISTRY`,
        ).toBe(true)
      }
    }
  })

  it('no curated entry has raw_equivalent: null — field is string or omitted', async () => {
    const result = await listToolsRuntime({ flags: {} })
    for (const entry of result.data.curated) {
      expect(
        entry.raw_equivalent,
        `entry "${entry.id}" has raw_equivalent: null`,
      ).not.toBeNull()
    }
  })

  it('meta.command is "list-tools"', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.meta.command).toBe('list-tools')
  })

  it('INT-04 snapshot: full data object', async () => {
    const result = await listToolsRuntime({ flags: {} })
    expect(result.data).toMatchSnapshot('list-tools-full')
  })
})
