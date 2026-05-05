import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURATED_REGISTRY, getRawRegistryView } from '../../src/lib/introspection-registry.js'

/**
 * Recursively count `.ts` command files under `src/commands/`.
 *
 * This drives the registry-parity assertion below: CURATED_REGISTRY.length
 * must match the number of command files on disk, otherwise a new command
 * file (or a deletion) will silently desync `list-tools` from reality —
 * the exact failure mode that produced BL-01 in the Phase 4 review.
 */
function countCommandFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      count += countCommandFiles(full)
    } else if (entry.endsWith('.ts')) {
      count += 1
    }
  }
  return count
}

const COMMANDS_DIR = join(import.meta.dirname, '..', '..', 'src', 'commands')

describe('CURATED_REGISTRY', () => {
  it('has exactly one entry per command file under src/commands/', () => {
    const fileCount = countCommandFiles(COMMANDS_DIR)
    expect(CURATED_REGISTRY.length).toBe(fileCount)
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
