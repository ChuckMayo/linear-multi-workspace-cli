/**
 * list-tools oclif command tests (Phase 4 PLAN 04-02, INT-01).
 *
 * Coverage:
 *   1. Command description is non-empty
 *   2. enableJsonFlag is true
 *   3. No workspace flag defined (list-tools makes zero network calls)
 */
import { describe, expect, it } from 'vitest'
import ListTools from '../../src/commands/list-tools.js'

describe('ListTools command', () => {
  it('has a non-empty description', () => {
    expect(ListTools.description).toBeTruthy()
    expect(typeof ListTools.description).toBe('string')
    expect((ListTools.description as string).length).toBeGreaterThan(0)
  })

  it('has enableJsonFlag set to true', () => {
    expect(ListTools.enableJsonFlag).toBe(true)
  })

  it('does not have a workspace flag (zero network calls)', () => {
    const flagNames = Object.keys(ListTools.flags ?? {})
    expect(flagNames).not.toContain('workspace')
  })
})
