/**
 * schema oclif command tests (Phase 4 PLAN 04-04, INT-03).
 *
 * Coverage:
 *   1. Command description is non-empty
 *   2. enableJsonFlag is true
 *   3. --full flag is defined (boolean)
 *   4. --json flag is defined (boolean)
 *   5. No --workspace flag (zero network calls)
 */
import { describe, expect, it } from 'vitest'
import Schema from '../../src/commands/schema.js'

describe('Schema command', () => {
  it('has a non-empty description', () => {
    expect(Schema.description).toBeTruthy()
    expect(typeof Schema.description).toBe('string')
    expect((Schema.description as string).length).toBeGreaterThan(0)
  })

  it('has enableJsonFlag set to true', () => {
    expect(Schema.enableJsonFlag).toBe(true)
  })

  it('defines a --full boolean flag', () => {
    const flags = Schema.flags ?? {}
    expect(flags).toHaveProperty('full')
    expect(flags['full']?.type).toBe('boolean')
  })

  it('defines a --json boolean flag', () => {
    const flags = Schema.flags ?? {}
    expect(flags).toHaveProperty('json')
    expect(flags['json']?.type).toBe('boolean')
  })

  it('does not have a --workspace flag (zero network calls)', () => {
    const flagNames = Object.keys(Schema.flags ?? {})
    expect(flagNames).not.toContain('workspace')
  })
})
