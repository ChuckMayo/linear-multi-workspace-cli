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

export const FIELD_PRESETS = {
  issue: ISSUE_PRESETS,
  // Future entities (comment, project, cycle, team, label, state, user) land
  // here in Phase 2 alongside their curated commands.
} as const

export type EntityName = keyof typeof FIELD_PRESETS
export type FieldPreset = 'ids' | 'defaults' | 'full'
