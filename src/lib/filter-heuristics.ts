/**
 * Filter heuristics — UUID/email/team-key/issue-identifier routing for
 * entity filter flags. Extracted from `issue-list-runtime.ts` (Phase 1) so
 * `issue search`, future entity lists, and resolvers share the same shape
 * detection without drift (Phase 2 PLAN 02-01 Task 2; CONTEXT § Specifics).
 *
 * `buildIssueFilter` mirrors the original Phase 1 behavior verbatim for the
 * three flags it accepted (`state`, `assignee`, `team`) and adds three
 * forward-looking flags (`label`, `project`, `cycle`) that downstream Phase
 * 2 plans will surface in their command flags.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const TEAM_KEY_RE = /^[A-Z0-9]{2,6}$/i
/** Linear issue identifiers like `ENG-123`. */
export const ISSUE_IDENTIFIER_RE = /^([A-Z][A-Z0-9]+)-(\d+)$/i

export type IdentifierKind = 'uuid' | 'email' | 'teamKey' | 'me' | 'issueIdentifier' | 'name'

/**
 * Classify a free-form identifier string into the routing bucket the typed
 * SDK filter shape expects (UUID → `id`, email → `email`, ENG → `key`,
 * `me` → `isMe`, `ENG-123` → issue identifier, anything else → name).
 *
 * The `me` literal is checked first because it would otherwise match the
 * 2-char team-key pattern.
 */
export function classifyIdentifier(value: string): IdentifierKind {
  if (value === 'me') return 'me'
  if (UUID_RE.test(value)) return 'uuid'
  if (EMAIL_RE.test(value)) return 'email'
  if (ISSUE_IDENTIFIER_RE.test(value)) return 'issueIdentifier'
  if (TEAM_KEY_RE.test(value)) return 'teamKey'
  return 'name'
}

export interface IssueFilterShape {
  state?: { id?: { eq: string }; name?: { eq: string } }
  assignee?: { id?: { eq: string }; email?: { eq: string }; isMe?: { eq: boolean } }
  team?: { id?: { eq: string }; key?: { eq: string }; name?: { eq: string } }
  labels?: { id?: { eq: string }; name?: { eq: string } }
  project?: { id?: { eq: string }; name?: { eq: string } }
  cycle?: { id?: { eq: string } }
}

export interface IssueFilterFlags {
  state?: string
  assignee?: string
  team?: string
  /** Forward-looking — issue list will surface in Phase 2 issue search / Phase 3 RAW-04. */
  label?: string
  /** Forward-looking — see `label` above. */
  project?: string
  /** Forward-looking — see `label` above. */
  cycle?: string
}

/**
 * Build a typed-SDK `IssueFilter` from free-form CLI flag values.
 *
 * Behavior matches Phase 1 `issue-list-runtime.ts:140-174` for the three
 * original flags (`state`, `assignee`, `team`) — verified by Test 31 in the
 * Plan 02-01 Task 2 test suite, which is a regression check against the
 * original implementation.
 */
export function buildIssueFilter(flags: IssueFilterFlags): IssueFilterShape | undefined {
  const filter: IssueFilterShape = {}

  if (flags.state) {
    filter.state = UUID_RE.test(flags.state)
      ? { id: { eq: flags.state } }
      : { name: { eq: flags.state } }
  }

  if (flags.assignee) {
    if (flags.assignee === 'me') {
      filter.assignee = { isMe: { eq: true } }
    } else if (EMAIL_RE.test(flags.assignee)) {
      filter.assignee = { email: { eq: flags.assignee } }
    } else if (UUID_RE.test(flags.assignee)) {
      filter.assignee = { id: { eq: flags.assignee } }
    } else {
      // Default: treat unknown shapes as email (most common Linear-public ID).
      filter.assignee = { email: { eq: flags.assignee } }
    }
  }

  if (flags.team) {
    if (UUID_RE.test(flags.team)) {
      filter.team = { id: { eq: flags.team } }
    } else if (TEAM_KEY_RE.test(flags.team)) {
      filter.team = { key: { eq: flags.team.toUpperCase() } }
    } else {
      filter.team = { name: { eq: flags.team } }
    }
  }

  if (flags.label) {
    filter.labels = UUID_RE.test(flags.label)
      ? { id: { eq: flags.label } }
      : { name: { eq: flags.label } }
  }

  if (flags.project) {
    filter.project = UUID_RE.test(flags.project)
      ? { id: { eq: flags.project } }
      : { name: { eq: flags.project } }
  }

  if (flags.cycle) {
    filter.cycle = { id: { eq: flags.cycle } }
  }

  if (Object.keys(filter).length === 0) return undefined
  return filter
}
