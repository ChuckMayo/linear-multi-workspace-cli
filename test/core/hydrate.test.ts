/**
 * `hydrateRelations` tests.
 *
 * The real `@linear/sdk` entity classes expose relations (`issue.state`,
 * `project.lead`, ...) as getters on the class prototype. `Object.keys` and
 * object spread only see own properties, so a hydrator that walks own keys
 * never finds them and every relation projects as null. These tests build
 * entities the way the SDK does (prototype getters returning promises) so
 * that regression stays caught.
 */
import { describe, expect, it, vi } from 'vitest'
import { FULL_PRESET, hydrateRelations, parseFields } from '@/core/projection/index.js'

function makeSdkLikeIssue(onStateRead: () => void = () => {}) {
  class SdkIssue {
    id = 'issue-1'
    identifier = 'ENG-1'
    _state = { id: 'state-1' }
    get state() {
      onStateRead()
      return Promise.resolve({ id: 'state-1', name: 'In Progress' })
    }
    get assignee() {
      return Promise.resolve({ id: 'user-1', email: 'a@example.com' })
    }
    get team() {
      return undefined
    }
  }
  return new SdkIssue() as unknown as Record<string, unknown>
}

const ISSUE_RELATIONS = ['state', 'assignee', 'team', 'project', 'cycle', 'parent']

describe('hydrateRelations', () => {
  it('resolves relations exposed as prototype getters', async () => {
    const issue = makeSdkLikeIssue()
    const spec = parseFields('id,state.name,assignee.email', 'issue')
    const out = await hydrateRelations(issue, ISSUE_RELATIONS, spec)
    expect(out.id).toBe('issue-1')
    expect(out.state).toEqual({ id: 'state-1', name: 'In Progress' })
    expect(out.assignee).toEqual({ id: 'user-1', email: 'a@example.com' })
  })

  it('does not read relation getters the spec does not reference', async () => {
    const onStateRead = vi.fn()
    const issue = makeSdkLikeIssue(onStateRead)
    const out = await hydrateRelations(issue, ISSUE_RELATIONS, parseFields('ids', 'issue'))
    expect(onStateRead).not.toHaveBeenCalled()
    expect('state' in out).toBe(false)
    expect(out.identifier).toBe('ENG-1')
  })

  it('hydrates every relation for the full preset and skips undefined ones', async () => {
    const out = await hydrateRelations(makeSdkLikeIssue(), ISSUE_RELATIONS, FULL_PRESET)
    expect(out.state).toEqual({ id: 'state-1', name: 'In Progress' })
    expect('team' in out).toBe(false)
  })

  it('still handles plain objects with relations as own promise properties', async () => {
    const plain = { id: 'p-1', lead: Promise.resolve({ email: 'lead@example.com' }) }
    const out = await hydrateRelations(
      plain,
      ['lead', 'creator'],
      parseFields('lead.email', 'project'),
    )
    expect(out.lead).toEqual({ email: 'lead@example.com' })
  })

  it('reads relations from an explicit source when the base object was rebuilt', async () => {
    const issue = makeSdkLikeIssue()
    const base = { id: 'issue-1', snippet: 'match' }
    const out = await hydrateRelations(
      base,
      ISSUE_RELATIONS,
      parseFields('state.name', 'issue'),
      issue,
    )
    expect(out.snippet).toBe('match')
    expect(out.state).toEqual({ id: 'state-1', name: 'In Progress' })
  })
})
