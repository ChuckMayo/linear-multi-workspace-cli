import { describe, expect, it } from 'vitest'
import { CURATED_REGISTRY, getRawRegistryView } from '../../src/lib/introspection-registry.js'

const EXPECTED_REGISTRY_SIZE = 36

describe('CURATED_REGISTRY', () => {
  it(`has exactly ${EXPECTED_REGISTRY_SIZE} entries matching the curated command files`, () => {
    expect(CURATED_REGISTRY.length).toBe(EXPECTED_REGISTRY_SIZE)
  })

  it('has all unique ids', () => {
    const ids = CURATED_REGISTRY.map((e) => e.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('is sorted alphabetically by id', () => {
    const ids = CURATED_REGISTRY.map((e) => e.id)
    const sorted = [...ids].sort((a, b) => a.localeCompare(b))
    expect(ids).toEqual(sorted)
  })

  it('every entry has truthy id, summary, flags array, and non-null inputSchema', () => {
    for (const entry of CURATED_REGISTRY) {
      expect(entry.id, `entry.id missing`).toBeTruthy()
      expect(entry.summary, `${entry.id}.summary missing`).toBeTruthy()
      expect(Array.isArray(entry.flags), `${entry.id}.flags is not an array`).toBe(true)
      expect(entry.inputSchema, `${entry.id}.inputSchema is null/undefined`).not.toBeNull()
      expect(entry.inputSchema, `${entry.id}.inputSchema is null/undefined`).not.toBeUndefined()
    }
  })

  it('every entry with raw_equivalent has a PascalCase string value', () => {
    const pascalCaseRe = /^[A-Z][a-zA-Z]+$/
    for (const entry of CURATED_REGISTRY) {
      if (entry.raw_equivalent !== undefined) {
        expect(
          pascalCaseRe.test(entry.raw_equivalent),
          `${entry.id}.raw_equivalent "${entry.raw_equivalent}" is not PascalCase`,
        ).toBe(true)
      }
    }
  })

  it('structural snapshot of ids, flags, and raw_equivalent', () => {
    const structure = CURATED_REGISTRY.map((e) => ({
      id: e.id,
      flags: e.flags,
      raw_equivalent: e.raw_equivalent,
    }))
    expect(structure).toMatchSnapshot('curated-registry-structure')
  })
})

describe('getRawRegistryView', () => {
  it('returns an array with entries for every OPERATION_REGISTRY key', () => {
    const view = getRawRegistryView()
    // The registry has ~501 entries; just verify it's a non-trivial list
    expect(view.length).toBeGreaterThan(400)
  })

  it('every entry has a string name and kind in [query, mutation]', () => {
    const view = getRawRegistryView()
    for (const entry of view) {
      expect(typeof entry.name).toBe('string')
      expect(['query', 'mutation']).toContain(entry.kind)
    }
  })
})
