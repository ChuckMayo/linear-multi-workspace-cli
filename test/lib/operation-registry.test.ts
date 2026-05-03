/**
 * Wave 0 registry-shape + per-entry integrity tests for OPERATION_REGISTRY.
 *
 * Phase 3 PLAN 03-01 — these tests are RED until Task 2 emits
 * src/generated/operations.ts with the populated registry. After Task 2
 * lands, both pin the registry contract for future schema bumps:
 *   - Test 1 snapshots count + first/last 3 sorted operation names + per-kind
 *     counts. A Linear schema bump surfaces as a tiny readable diff.
 *   - Test 2 iterates EVERY entry and checks shape (kind, source, varsSchema).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OPERATION_REGISTRY, type OperationEntry } from '@/generated/operations.js'

// Re-cast as Record<string, OperationEntry> so iteration sees the documented
// shape regardless of whether the registry has been populated yet (Task 1
// ships an empty placeholder; Task 2 fills it in).
const REGISTRY = OPERATION_REGISTRY as Record<string, OperationEntry>

describe('OPERATION_REGISTRY', () => {
  it('Test 1 (RED→GREEN) — registry-shape snapshot', () => {
    const keys = Object.keys(REGISTRY).slice().sort()
    let queryCount = 0
    let mutationCount = 0
    for (const k of keys) {
      const entry = REGISTRY[k]
      if (!entry) continue
      if (entry.kind === 'query') queryCount++
      if (entry.kind === 'mutation') mutationCount++
    }
    expect({
      count: keys.length,
      first3: keys.slice(0, 3),
      last3: keys.slice(-3),
      kinds: { query: queryCount, mutation: mutationCount },
    }).toMatchSnapshot()
  })

  it('Test 2 (RED→GREEN) — every entry has the documented shape', () => {
    const keys = Object.keys(REGISTRY)
    // RED: empty registry from Task 1 stub will fail this assertion. After
    // Task 2 emits the populated registry, this turns GREEN.
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      const entry = REGISTRY[k]
      if (!entry) throw new Error(`registry key ${k} resolved to undefined`)
      expect(entry.kind).toMatch(/^(query|mutation)$/)
      expect(typeof entry.source).toBe('string')
      expect(entry.source.length).toBeGreaterThan(0)
      // varsSchema must be a Zod schema (has .safeParse)
      expect(typeof entry.varsSchema?.safeParse).toBe('function')
      // and accept an empty object (most ops have all-optional vars; required
      // ops will surface as VarsInvalid, which is fine — we just confirm the
      // schema is callable, not that empty input passes)
      const result = entry.varsSchema.safeParse({})
      expect(typeof result.success).toBe('boolean')
    }
  })

  it('subscriptions are excluded from the registry', () => {
    for (const k of Object.keys(REGISTRY)) {
      const entry = REGISTRY[k]
      if (!entry) continue
      // OperationKind is 'query' | 'mutation' so 'subscription' is a type
      // error at compile time; this asserts the runtime invariant.
      const kindAsString: string = entry.kind
      expect(kindAsString).not.toBe('subscription')
    }
  })

  it('OPERATION_REGISTRY entry keys are PascalCase', () => {
    const bad: string[] = []
    for (const k of Object.keys(REGISTRY)) {
      // First char must be uppercase letter; remaining must be alphanumeric.
      if (!/^[A-Z][A-Za-z0-9]*$/.test(k)) bad.push(k)
    }
    expect(bad).toEqual([])
  })

  it('Zod schema export is consumable', () => {
    // Sanity: importing z above means tests can construct comparable schemas.
    expect(z).toBeDefined()
  })
})
