/**
 * Unit tests for `src/lib/filter-heuristics.ts` (Phase 2 PLAN 02-01 Task 2).
 *
 * Verifies that the regexes (UUID/email/team-key/issue-identifier),
 * `classifyIdentifier`, and `buildIssueFilter` match the original Phase 1
 * `issue-list-runtime.ts:140-174` behavior verbatim for the three flags
 * that runtime accepted (state, assignee, team) AND extends correctly to
 * the three forward-looking flags (label, project, cycle).
 */
import { describe, expect, it } from 'vitest'
import {
  buildIssueFilter,
  classifyIdentifier,
  EMAIL_RE,
  ISSUE_IDENTIFIER_RE,
  TEAM_KEY_RE,
  UUID_RE,
} from '@/lib/filter-heuristics.js'

describe('Regex predicates', () => {
  it('Test 22: UUID_RE matches a canonical 8-4-4-4-12 hex UUID', () => {
    expect(UUID_RE.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true)
    expect(UUID_RE.test('11111111-2222-3333-4444-555555555555')).toBe(true)
  })

  it('Test 23: UUID_RE rejects an issue identifier ENG-123', () => {
    expect(UUID_RE.test('ENG-123')).toBe(false)
  })

  it('Test 24: EMAIL_RE matches foo@bar.com', () => {
    expect(EMAIL_RE.test('foo@bar.com')).toBe(true)
    expect(EMAIL_RE.test('alice+filter@example.co.uk')).toBe(true)
    expect(EMAIL_RE.test('not-an-email')).toBe(false)
  })

  it('Test 25: TEAM_KEY_RE matches 2-6 alphanumeric chars; rejects longer strings', () => {
    expect(TEAM_KEY_RE.test('ENG')).toBe(true)
    expect(TEAM_KEY_RE.test('A1')).toBe(true)
    expect(TEAM_KEY_RE.test('SUPER1')).toBe(true) // 6 chars OK
    expect(TEAM_KEY_RE.test('LONGNAME')).toBe(false) // 8 chars too long
    expect(TEAM_KEY_RE.test('A')).toBe(false) // 1 char too short
  })

  it('ISSUE_IDENTIFIER_RE matches ENG-123 / abc-1', () => {
    expect(ISSUE_IDENTIFIER_RE.test('ENG-123')).toBe(true)
    expect(ISSUE_IDENTIFIER_RE.test('abc-1')).toBe(true)
    expect(ISSUE_IDENTIFIER_RE.test('ENG123')).toBe(false)
  })
})

describe('classifyIdentifier', () => {
  it('Test 26: classifyIdentifier of a canonical UUID returns "uuid"', () => {
    expect(classifyIdentifier('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('uuid')
  })
  it('Test 27: classifyIdentifier of an email returns "email"', () => {
    expect(classifyIdentifier('foo@bar.com')).toBe('email')
  })
  it('Test 28: classifyIdentifier of a team key returns "teamKey"', () => {
    expect(classifyIdentifier('ENG')).toBe('teamKey')
  })
  it('Test 29: classifyIdentifier("me") returns "me" (precedes teamKey check)', () => {
    expect(classifyIdentifier('me')).toBe('me')
  })
  it('Test 30: classifyIdentifier of a freeform string returns "name"', () => {
    expect(classifyIdentifier('Some Name With Spaces')).toBe('name')
  })
  it('classifyIdentifier of an issue identifier returns "issueIdentifier"', () => {
    expect(classifyIdentifier('ENG-123')).toBe('issueIdentifier')
  })
})

describe('buildIssueFilter — Phase 1 regression (state/assignee/team)', () => {
  it('Test 31: state="In Progress" maps to { state: { name: { eq: ... } } }', () => {
    expect(buildIssueFilter({ state: 'In Progress' })).toEqual({
      state: { name: { eq: 'In Progress' } },
    })
  })

  it('Test 32: empty flags returns undefined', () => {
    expect(buildIssueFilter({})).toBeUndefined()
  })

  it('state UUID maps to { state: { id: { eq: ... } } }', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(buildIssueFilter({ state: id })).toEqual({ state: { id: { eq: id } } })
  })

  it('assignee="me" maps to { assignee: { isMe: { eq: true } } }', () => {
    expect(buildIssueFilter({ assignee: 'me' })).toEqual({
      assignee: { isMe: { eq: true } },
    })
  })

  it('assignee email maps to { assignee: { email: { eq: ... } } }', () => {
    expect(buildIssueFilter({ assignee: 'a@b.co' })).toEqual({
      assignee: { email: { eq: 'a@b.co' } },
    })
  })

  it('assignee UUID maps to { assignee: { id: { eq: ... } } }', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(buildIssueFilter({ assignee: id })).toEqual({ assignee: { id: { eq: id } } })
  })

  it('team UUID/key/name routing matches Phase 1 issue-list-runtime', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(buildIssueFilter({ team: uuid })).toEqual({ team: { id: { eq: uuid } } })
    expect(buildIssueFilter({ team: 'eng' })).toEqual({ team: { key: { eq: 'ENG' } } })
    expect(buildIssueFilter({ team: 'Engineering Team' })).toEqual({
      team: { name: { eq: 'Engineering Team' } },
    })
  })

  it('combined state/assignee/team filters compose without drift', () => {
    expect(buildIssueFilter({ state: 'In Progress', assignee: 'me', team: 'ENG' })).toEqual({
      state: { name: { eq: 'In Progress' } },
      assignee: { isMe: { eq: true } },
      team: { key: { eq: 'ENG' } },
    })
  })
})

describe('buildIssueFilter — forward-looking flags (label/project/cycle)', () => {
  it('label by name', () => {
    expect(buildIssueFilter({ label: 'bug' })).toEqual({ labels: { name: { eq: 'bug' } } })
  })
  it('label by UUID', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(buildIssueFilter({ label: id })).toEqual({ labels: { id: { eq: id } } })
  })
  it('project by name vs UUID', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(buildIssueFilter({ project: 'Q1 Roadmap' })).toEqual({
      project: { name: { eq: 'Q1 Roadmap' } },
    })
    expect(buildIssueFilter({ project: id })).toEqual({ project: { id: { eq: id } } })
  })
  it('cycle always treated as id', () => {
    expect(buildIssueFilter({ cycle: 'cycle-id-1' })).toEqual({
      cycle: { id: { eq: 'cycle-id-1' } },
    })
  })
})
