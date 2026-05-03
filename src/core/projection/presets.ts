/**
 * Field presets for `--fields` projection (KRN-08, PITFALLS § Pitfall 1).
 *
 * Three preset names per entity:
 *   - `ids`      — minimal projection (just `id`, `identifier` for issues).
 *   - `defaults` — token-budget-friendly default (~120 tokens/issue).
 *   - `full`     — sentinel signaling "every field the typed SDK exposes" —
 *                  resolved by the projector to a no-op passthrough.
 *
 * `defaults` is non-negotiable on size: PITFALLS § Pitfall 1 calls out
 * narrow defaults as load-bearing. Adding a field here without removing one
 * is a regression that should require explicit review.
 *
 * Phase 2 PLAN 02-01 adds 7 entity presets (`comment`, `project`, `cycle`,
 * `team`, `label`, `state`, `user`) so downstream Phase 2 plans can call
 * `parseFields(input, '<entity>')` without registry expansion.
 */
export const FULL_PRESET = '*' as const
export type FullPreset = typeof FULL_PRESET

export const ISSUE_PRESETS = {
  ids: ['id', 'identifier'] as const,
  defaults: [
    'id',
    'identifier',
    'title',
    'state.name',
    'priority',
    'assignee.email',
    'team.key',
    'updatedAt',
  ] as const,
  full: FULL_PRESET,
} as const

export const COMMENT_PRESETS = {
  ids: ['id'] as const,
  defaults: [
    'id',
    'body',
    'user.email',
    'user.name',
    'issue.identifier',
    'parent.id',
    'createdAt',
    'updatedAt',
  ] as const,
  full: FULL_PRESET,
} as const

export const PROJECT_PRESETS = {
  ids: ['id'] as const,
  defaults: [
    'id',
    'name',
    'state',
    'progress',
    'targetDate',
    'lead.email',
    'description',
    'updatedAt',
  ] as const,
  full: FULL_PRESET,
} as const

export const CYCLE_PRESETS = {
  ids: ['id'] as const,
  defaults: [
    'id',
    'number',
    'name',
    'startsAt',
    'endsAt',
    'progress',
    'team.key',
    'isActive',
  ] as const,
  full: FULL_PRESET,
} as const

export const TEAM_PRESETS = {
  ids: ['id', 'key'] as const,
  defaults: [
    'id',
    'key',
    'name',
    'description',
    'color',
    'private',
    'createdAt',
    'cycleEnabled',
  ] as const,
  full: FULL_PRESET,
} as const

export const LABEL_PRESETS = {
  ids: ['id'] as const,
  defaults: [
    'id',
    'name',
    'color',
    'description',
    'team.key',
    'parent.name',
    'createdAt',
    'updatedAt',
  ] as const,
  full: FULL_PRESET,
} as const

export const STATE_PRESETS = {
  ids: ['id'] as const,
  defaults: [
    'id',
    'name',
    'type',
    'color',
    'position',
    'team.key',
    'description',
    'createdAt',
  ] as const,
  full: FULL_PRESET,
} as const

export const USER_PRESETS = {
  ids: ['id'] as const,
  defaults: ['id', 'name', 'email', 'displayName', 'admin', 'isMe', 'active', 'avatarUrl'] as const,
  full: FULL_PRESET,
} as const

export const FIELD_PRESETS = {
  issue: ISSUE_PRESETS,
  comment: COMMENT_PRESETS,
  project: PROJECT_PRESETS,
  cycle: CYCLE_PRESETS,
  team: TEAM_PRESETS,
  label: LABEL_PRESETS,
  state: STATE_PRESETS,
  user: USER_PRESETS,
} as const

export type EntityName = keyof typeof FIELD_PRESETS
export type FieldPreset = 'ids' | 'defaults' | 'full'
