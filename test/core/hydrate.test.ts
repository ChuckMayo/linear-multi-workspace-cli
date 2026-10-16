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
import { NetworkLinearError } from '@linear/sdk'
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

  it('fetches a relation shared by many entities once per client and id', async () => {
    const request = () => {}
    const teamFetch = vi.fn(() => Promise.resolve({ id: 'team-1', key: 'ENG' }))
    class SdkIssue {
      _request = request
      _team = { id: 'team-1' }
      constructor(public id: string) {}
      get team() {
        return teamFetch()
      }
    }
    const spec = parseFields('id,team.key', 'issue')
    const rows = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        hydrateRelations(new SdkIssue(id) as unknown as Record<string, unknown>, ['team'], spec),
      ),
    )
    expect(teamFetch).toHaveBeenCalledTimes(1)
    expect(rows.map((r) => r.team)).toEqual([
      { id: 'team-1', key: 'ENG' },
      { id: 'team-1', key: 'ENG' },
      { id: 'team-1', key: 'ENG' },
    ])
  })

  it('answers id-only relation paths from the private id without a fetch', async () => {
    const parentFetch = vi.fn(() => Promise.resolve({ id: 'p-1', identifier: 'ENG-0' }))
    class SdkComment {
      _request = () => {}
      _parent = { id: 'p-1' }
      _issue = undefined
      id = 'c-1'
      get parent() {
        return parentFetch()
      }
      get issue() {
        return Promise.resolve({ id: 'never' })
      }
    }
    const out = await hydrateRelations(
      new SdkComment() as unknown as Record<string, unknown>,
      ['parent', 'issue'],
      parseFields('id,parent.id,issue.id', 'comment'),
    )
    expect(parentFetch).not.toHaveBeenCalled()
    expect(out.parent).toEqual({ id: 'p-1' })
    expect('issue' in out).toBe(false)
  })

  it('retries a relation fetch that hits a transient network error', async () => {
    let calls = 0
    class SdkIssue {
      id = 'i-1'
      get state() {
        calls++
        return calls === 1
          ? Promise.reject(new NetworkLinearError())
          : Promise.resolve({ name: 'Todo' })
      }
    }
    const out = await hydrateRelations(
      new SdkIssue() as unknown as Record<string, unknown>,
      ['state'],
      parseFields('state.name', 'issue'),
      undefined,
      { retry: { sleep: async () => {} } },
    )
    expect(calls).toBe(2)
    expect(out.state).toEqual({ name: 'Todo' })
  })
})
