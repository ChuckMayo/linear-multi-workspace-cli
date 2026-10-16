/**
 * Shared relation hydration for SDK entities before projection.
 *
 * `@linear/sdk` entity classes expose relations (`issue.state`,
 * `project.lead`, `label.team`, ...) as getters on the class prototype that
 * return a promise. `Object.keys` and object spread only see own properties,
 * so they never reach those getters; the instance's own keys are the private
 * `_state` / `_lead` id holders instead. Relations must therefore be read by
 * property access, which walks the prototype chain.
 *
 * Only relations the projection spec references are read, because each read
 * fires a network request. `FULL_PRESET` reads every listed relation.
 */
import { FULL_PRESET } from './presets.js'
import type { ProjectionSpec } from './project.js'

/**
 * Copy `base`'s own non-relation keys, then resolve each relation the spec
 * needs from `source` (defaults to `base`). Pass `source` when the caller has
 * already rebuilt `base` as a plain object (e.g. to add a search snippet) and
 * the relation getters live on the original SDK instance.
 */
export async function hydrateRelations(
  base: Record<string, unknown>,
  relationKeys: Iterable<string>,
  spec: ProjectionSpec,
  source: object = base,
): Promise<Record<string, unknown>> {
  const relations = new Set(relationKeys)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(base)) {
    if (!relations.has(k)) out[k] = base[k]
  }
  for (const k of neededRelations(spec, relations)) {
    const value = (source as Record<string, unknown>)[k]
    if (value === undefined) continue
    out[k] = await value
  }
  return out
}

function neededRelations(spec: ProjectionSpec, relations: Set<string>): Set<string> {
  if (spec === FULL_PRESET) return relations
  const out = new Set<string>()
  for (const path of spec) {
    const head = path.split('.')[0]
    if (head && relations.has(head)) out.add(head)
  }
  return out
}
