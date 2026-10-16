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
 * Each getter read fires an uncached network request, so:
 *   - only relations the projection spec references are read
 *     (`FULL_PRESET` reads every listed relation);
 *   - a spec that only asks for `<relation>.id` is answered from the
 *     private `_<relation>.id` without a fetch;
 *   - fetches are shared per SDK client (`_request`) and related-entity id,
 *     so a list of issues on one team fetches that team once;
 *   - each fetch runs inside `withRateLimitRetry`, like the main query.
 */
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/index.js'
import { FULL_PRESET } from './presets.js'
import type { ProjectionSpec } from './project.js'

export interface HydrateOptions {
  /** Passes through to `withRateLimitRetry` (test seam for sleep/backoff). */
  retry?: RetryOpts
}

const sharedFetches = new WeakMap<object, Map<string, Promise<unknown>>>()

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
  options: HydrateOptions = {},
): Promise<Record<string, unknown>> {
  const relations = new Set(relationKeys)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(base)) {
    if (!relations.has(k)) out[k] = base[k]
  }
  const entity = source as Record<string, unknown>
  for (const [k, paths] of neededRelations(spec, relations)) {
    const privateRef = privateIdHolder(entity, k)
    if (privateRef.present && privateRef.id === undefined) continue
    if (privateRef.id !== undefined && paths !== 'all' && onlyIdPaths(k, paths)) {
      out[k] = { id: privateRef.id }
      continue
    }
    const value = await readRelation(entity, k, privateRef.id, options.retry)
    if (value === undefined) continue
    out[k] = value
  }
  return out
}

function readRelation(
  entity: Record<string, unknown>,
  key: string,
  relatedId: string | undefined,
  retry: RetryOpts | undefined,
): Promise<unknown> {
  const fetchOnce = () => withRateLimitRetry(async () => await entity[key], retry)
  const client = entity._request
  if (relatedId === undefined || (typeof client !== 'function' && typeof client !== 'object')) {
    return fetchOnce()
  }
  let byKey = sharedFetches.get(client as object)
  if (!byKey) {
    byKey = new Map()
    sharedFetches.set(client as object, byKey)
  }
  const cacheKey = `${key}:${relatedId}`
  const cached = byKey.get(cacheKey)
  if (cached) return cached
  const pending = fetchOnce()
  byKey.set(cacheKey, pending)
  pending.catch(() => byKey?.delete(cacheKey))
  return pending
}

/** The SDK stores each relation as `_<name>: { id } | undefined` on the instance. */
function privateIdHolder(
  entity: Record<string, unknown>,
  key: string,
): { present: boolean; id: string | undefined } {
  const holderKey = `_${key}`
  if (!Object.hasOwn(entity, holderKey)) return { present: false, id: undefined }
  const holder = entity[holderKey] as { id?: unknown } | undefined | null
  const id = holder && typeof holder.id === 'string' ? holder.id : undefined
  return { present: true, id }
}

function onlyIdPaths(key: string, paths: Set<string>): boolean {
  for (const p of paths) if (p !== `${key}.id`) return false
  return true
}

function neededRelations(
  spec: ProjectionSpec,
  relations: Set<string>,
): Map<string, Set<string> | 'all'> {
  const out = new Map<string, Set<string> | 'all'>()
  if (spec === FULL_PRESET) {
    for (const k of relations) out.set(k, 'all')
    return out
  }
  for (const path of spec) {
    const head = path.split('.')[0]
    if (!head || !relations.has(head)) continue
    const paths = out.get(head)
    if (paths === undefined) out.set(head, new Set([path]))
    else if (paths !== 'all') paths.add(path)
  }
  return out
}
