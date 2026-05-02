/**
 * Field projection — parses the `--fields` flag and projects an arbitrary
 * value tree to the requested dot-paths.
 *
 * Two-stage pipeline (KRN-08, ISS-01):
 *   1. parseFields(input, entity) → `ProjectionSpec` (preset paths or sentinel)
 *      - Preset names ("ids" / "defaults" / "full") resolve to the entity's
 *        preset entry.
 *      - Custom CSV ("id,title,state.name") is split, trimmed, and validated
 *        against the entity's allowed-field registry. Unknown paths throw
 *        `INVALID_FIELD` (exit 2).
 *   2. project(value, spec) → projected value
 *      - For `FULL_PRESET`, returns the input unchanged (deep-clone not
 *        required; identity is preserved).
 *      - For a path array, walks each dot-path and copies the leaf into a
 *        fresh object tree. Missing nested keys yield `null` rather than
 *        throwing — agents reading the envelope can rely on "key present"
 *        being a stable contract independent of upstream data shape.
 *
 * Allowed-field registry: a per-entity `Set<string>` of dot-paths. Phase 1
 * only registers the `issue` entity; Phase 2 extends this to every curated
 * read command. The registry is the contract for what `--fields` accepts —
 * widening it requires a deliberate code change + a test.
 *
 * Threat model (T-01-25, T-01-26):
 *   - Custom field paths are untrusted input; the registry gates them.
 *   - Filter values surfaced in `INVALID_FIELD` details are the user's own
 *     CSV input (not secrets) — kernel redactor still scrubs token-shaped
 *     substrings as defense in depth.
 */

import { LinearAgentError } from '../errors/index.js'
import { type EntityName, FIELD_PRESETS, FULL_PRESET, type FullPreset } from './presets.js'

export type ProjectionSpec = readonly string[] | FullPreset

/**
 * Allowed dot-paths per entity. Custom `--fields` CSV values are validated
 * against this registry; unknown paths trigger `INVALID_FIELD`.
 *
 * The list is intentionally generous (we'd rather accept a field and get
 * `null` from `project()` than reject a perfectly valid SDK field). Phase 2
 * expands this as new commands ship; Phase 3's raw GraphQL passthrough side-
 * steps the registry entirely.
 */
const ALLOWED_FIELDS: Record<EntityName, ReadonlySet<string>> = {
  issue: new Set([
    'id',
    'identifier',
    'title',
    'description',
    'priority',
    'priorityLabel',
    'estimate',
    'sortOrder',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'completedAt',
    'startedAt',
    'canceledAt',
    'dueDate',
    'snoozedUntilAt',
    'state.id',
    'state.name',
    'state.type',
    'assignee.id',
    'assignee.email',
    'assignee.name',
    'team.id',
    'team.key',
    'team.name',
    'project.id',
    'project.name',
    'cycle.id',
    'cycle.number',
    'parent.id',
    'parent.identifier',
    'url',
  ]),
}

export function parseFields(input: string, entity: EntityName): ProjectionSpec {
  const normalized = input.trim()
  const presets = FIELD_PRESETS[entity]
  if (normalized === 'ids') return presets.ids
  if (normalized === 'defaults') return presets.defaults
  if (normalized === 'full') return FULL_PRESET

  // Custom CSV — split, trim, drop empties, validate against the registry.
  const paths = normalized
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const allowed = ALLOWED_FIELDS[entity]
  const unknown = paths.filter((p) => !allowed.has(p))
  if (unknown.length > 0) {
    throw new LinearAgentError({
      code: 'INVALID_FIELD',
      message: `unknown field(s) for ${entity}: ${unknown.join(', ')}`,
      details: { entity, unknown, allowed: [...allowed].sort() },
    })
  }
  return paths
}

/**
 * Walk `value` and pull out only the requested dot-paths. For each leaf:
 *   - If the upstream key exists, copy the value (no clone — references
 *     into the SDK shape are fine because we never mutate the result).
 *   - If the upstream key is missing at any level, the leaf is `null`.
 *
 * For `FULL_PRESET`, returns the input unchanged.
 */
export function project<T>(value: T, spec: ProjectionSpec): unknown {
  if (spec === FULL_PRESET) return value
  if (spec.length === 0) return {}

  const out: Record<string, unknown> = {}
  for (const path of spec) {
    const parts = path.split('.')
    let src: unknown = value
    let dst: Record<string, unknown> = out
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i] as string
      const isLeaf = i === parts.length - 1
      const srcValue = readKey(src, key)
      if (isLeaf) {
        dst[key] = srcValue ?? null
      } else {
        if (!(key in dst) || typeof dst[key] !== 'object' || dst[key] === null) {
          dst[key] = {}
        }
        dst = dst[key] as Record<string, unknown>
        src = srcValue
      }
    }
  }
  return out
}

function readKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  if (!(key in (value as Record<string, unknown>))) return undefined
  return (value as Record<string, unknown>)[key]
}
