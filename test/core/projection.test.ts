/**
 * Projection module tests (Phase 1 PLAN-05, KRN-08).
 *
 * Covers:
 *   - ISSUE_PRESETS shape (ids / defaults / full sentinel)
 *   - parseFields() — preset resolution, CSV parsing, allowed-field validation,
 *     INVALID_FIELD error path, whitespace handling, full sentinel
 *   - project() — leaf extraction, nested paths, missing-key null handling,
 *     full passthrough, empty-spec
 *
 * No SDK / network dependence; pure-function unit tests.
 */
import { describe, expect, it } from 'vitest'
import { LinearAgentError } from '@/core/errors/index.js'
import {
  FULL_PRESET,
  ISSUE_PRESETS,
  parseFields,
  project,
  type ProjectionSpec,
} from '@/core/projection/index.js'

describe('ISSUE_PRESETS', () => {
  it('Test 1: ISSUE_PRESETS.ids is exactly [id, identifier]', () => {
    expect(ISSUE_PRESETS.ids).toEqual(['id', 'identifier'])
  })

  it('Test 2: ISSUE_PRESETS.defaults has exactly the 8 documented entries in CONTEXT order', () => {
    expect(ISSUE_PRESETS.defaults).toEqual([
      'id',
      'identifier',
      'title',
      'state.name',
      'priority',
      'assignee.email',
      'team.key',
      'updatedAt',
    ])
    expect(ISSUE_PRESETS.defaults).toHaveLength(8)
  })

  it('Test 3: ISSUE_PRESETS.full is the FULL_PRESET sentinel', () => {
    expect(ISSUE_PRESETS.full).toBe(FULL_PRESET)
    expect(FULL_PRESET).toBe('*')
  })
})

describe('parseFields()', () => {
  it('Test 4: parseFields("defaults", "issue") returns the 8-path defaults preset', () => {
    expect(parseFields('defaults', 'issue')).toEqual(ISSUE_PRESETS.defaults)
  })

  it('Test 5: parseFields("ids", "issue") returns [id, identifier]', () => {
    expect(parseFields('ids', 'issue')).toEqual(['id', 'identifier'])
  })

  it('Test 6: parseFields("id,title,state.name", "issue") validates and returns the path array', () => {
    expect(parseFields('id,title,state.name', 'issue')).toEqual(['id', 'title', 'state.name'])
  })

  it('Test 7: parseFields("id,bogusField", "issue") throws INVALID_FIELD', () => {
    expect.assertions(4)
    try {
      parseFields('id,bogusField', 'issue')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('INVALID_FIELD')
      expect(err.message).toContain('bogusField')
      expect(err.details?.unknown).toEqual(['bogusField'])
    }
  })

  it('Test 8: parseFields("full", "issue") returns the FULL_PRESET sentinel', () => {
    expect(parseFields('full', 'issue')).toBe(FULL_PRESET)
  })

  it('Test 9: parseFields handles whitespace-only padding and per-token whitespace', () => {
    expect(parseFields('  defaults  ', 'issue')).toEqual(ISSUE_PRESETS.defaults)
    expect(parseFields('  id , title , state.name  ', 'issue')).toEqual([
      'id',
      'title',
      'state.name',
    ])
  })
})

describe('project()', () => {
  const sampleIssue = {
    id: '1',
    identifier: 'ENG-1',
    title: 't',
    state: { name: 'Done', id: 'x' },
    priority: 2,
    assignee: { email: 'a@b' },
    team: { key: 'ENG' },
    updatedAt: 'now',
    extra: 'IGNORED',
  }

  it('Test 10: returns only the requested paths with nested keys preserved', () => {
    const out = project(sampleIssue, ['id', 'identifier', 'state.name'])
    expect(out).toEqual({
      id: '1',
      identifier: 'ENG-1',
      state: { name: 'Done' },
    })
  })

  it('Test 11: missing nested keys yield null instead of throwing', () => {
    const out = project({ id: '1' }, ['state.name'])
    expect(out).toEqual({ state: { name: null } })
  })

  it('Test 12: project(obj, FULL_PRESET) returns the input unchanged', () => {
    const out = project(sampleIssue, FULL_PRESET as ProjectionSpec)
    expect(out).toEqual(sampleIssue)
  })

  it('Test 13: empty paths array returns empty object', () => {
    expect(project(sampleIssue, [])).toEqual({})
  })
})
