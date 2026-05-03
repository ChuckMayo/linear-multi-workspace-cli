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
  COMMENT_PRESETS,
  CYCLE_PRESETS,
  FIELD_PRESETS,
  FULL_PRESET,
  ISSUE_PRESETS,
  LABEL_PRESETS,
  PROJECT_PRESETS,
  type ProjectionSpec,
  parseFields,
  project,
  STATE_PRESETS,
  TEAM_PRESETS,
  USER_PRESETS,
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

// ─── Phase 2 PLAN 02-01 Task 2 — entity preset extension ─────────────────

describe('Phase 2 entity presets — defaults shape', () => {
  it('Test 10: COMMENT_PRESETS.defaults has 8 entries in the documented order', () => {
    expect(COMMENT_PRESETS.defaults).toEqual([
      'id',
      'body',
      'user.email',
      'user.name',
      'issue.identifier',
      'parent.id',
      'createdAt',
      'updatedAt',
    ])
    expect(COMMENT_PRESETS.defaults).toHaveLength(8)
  })

  it('Test 11: PROJECT_PRESETS.defaults has 8 entries', () => {
    expect(PROJECT_PRESETS.defaults).toHaveLength(8)
    expect(PROJECT_PRESETS.defaults).toContain('id')
    expect(PROJECT_PRESETS.defaults).toContain('name')
    expect(PROJECT_PRESETS.defaults).toContain('progress')
  })

  it('Test 12: CYCLE_PRESETS.defaults has 8 entries', () => {
    expect(CYCLE_PRESETS.defaults).toHaveLength(8)
    expect(CYCLE_PRESETS.defaults).toContain('isActive')
    expect(CYCLE_PRESETS.defaults).toContain('team.key')
  })

  it('Test 13: TEAM_PRESETS.defaults has 8 entries; ids includes [id, key]', () => {
    expect(TEAM_PRESETS.defaults).toHaveLength(8)
    expect(TEAM_PRESETS.ids).toEqual(['id', 'key'])
    expect(TEAM_PRESETS.defaults).toContain('cycleEnabled')
  })

  it('Test 14: LABEL_PRESETS.defaults has 8 entries', () => {
    expect(LABEL_PRESETS.defaults).toHaveLength(8)
    expect(LABEL_PRESETS.defaults).toContain('parent.name')
  })

  it('Test 15: STATE_PRESETS.defaults has 8 entries', () => {
    expect(STATE_PRESETS.defaults).toHaveLength(8)
    expect(STATE_PRESETS.defaults).toContain('type')
    expect(STATE_PRESETS.defaults).toContain('position')
  })

  it('Test 16: USER_PRESETS.defaults has 8 entries', () => {
    expect(USER_PRESETS.defaults).toHaveLength(8)
    expect(USER_PRESETS.defaults).toContain('isMe')
    expect(USER_PRESETS.defaults).toContain('avatarUrl')
  })
})

describe('Phase 2 parseFields — entity routing', () => {
  it('Test 17: parseFields("defaults", "comment") succeeds (no INVALID_FIELD)', () => {
    const out = parseFields('defaults', 'comment')
    expect(out).toEqual(COMMENT_PRESETS.defaults)
    expect((out as readonly string[]).length).toBe(8)
  })

  it('Test 18: parseFields("id,body,user.email", "comment") succeeds', () => {
    expect(parseFields('id,body,user.email', 'comment')).toEqual(['id', 'body', 'user.email'])
  })

  it('Test 19: parseFields("bogus.path", "comment") throws INVALID_FIELD', () => {
    expect.assertions(2)
    try {
      parseFields('bogus.path', 'comment')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('INVALID_FIELD')
    }
  })

  it('Test 20: every new entity has ALLOWED_FIELDS that is a SUPERSET of its defaults preset', () => {
    const entities = ['comment', 'project', 'cycle', 'team', 'label', 'state', 'user'] as const
    for (const entity of entities) {
      const defaults = FIELD_PRESETS[entity].defaults
      // If defaults is a superset of ALLOWED_FIELDS, this would throw INVALID_FIELD.
      // Run parseFields(defaults.join(','), entity) and expect no throw.
      expect(() => parseFields([...defaults].join(','), entity)).not.toThrow()
    }
  })

  it('Test 20a: parseFields("snippet", "issue") succeeds (Phase 2 ALLOWED_FIELDS.issue extension)', () => {
    expect(parseFields('snippet', 'issue')).toEqual(['snippet'])
  })

  it('Test 20b: parseFields("id,identifier,title,snippet", "issue") returns the 4-path array', () => {
    expect(parseFields('id,identifier,title,snippet', 'issue')).toEqual([
      'id',
      'identifier',
      'title',
      'snippet',
    ])
  })

  it('Test 21: EntityName widens to include all 8 entities (FIELD_PRESETS keys)', () => {
    const keys = Object.keys(FIELD_PRESETS).sort()
    expect(keys).toEqual(['comment', 'cycle', 'issue', 'label', 'project', 'state', 'team', 'user'])
    // TS-level check: parseFields('defaults', 'team') is callable without TS error.
    expect(parseFields('defaults', 'team')).toEqual(TEAM_PRESETS.defaults)
  })
})
