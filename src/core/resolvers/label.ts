/**
 * Label name → ID resolver (Phase 2 PLAN 02-02 Task 1).
 *
 * Translates a user-typed label name (e.g. `"p0"`) to its Linear label UUID
 * for the `--labels`, `--add-label`, and `--remove-label` flags on issue
 * create/update commands. UUID inputs pass through unchanged.
 *
 * Cache shape: `Map<"${workspace}:${teamId}", Promise<Map<lowercaseName, id>>>`.
 * Team-scoped per RESEARCH § Pitfall 13 (`label create` is also team-scoped
 * for parity with how Linear surfaces labels in the UI).
 *
 * `resolveLabelIds(client, workspace, teamId, names[])` resolves the entire
 * list with one bulk SDK call (UUIDs pass through; the cache absorbs duplicate
 * name lookups). Order is preserved (input order = output order).
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'

const cache = new Map<string, Promise<Map<string, string>>>()

/**
 * Resolve a label name (or UUID) to a label UUID, scoped to one
 * `${workspace}:${teamId}` pair.
 */
export async function resolveLabelId(
  client: LinearClient,
  workspaceName: string,
  teamId: string,
  nameOrId: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(nameOrId)) return nameOrId
  const key = `${workspaceName}:${teamId}`
  let map = cache.get(key)
  if (!map) {
    map = (async () => {
      const conn = await withRateLimitRetry(
        () => client.issueLabels({ filter: { team: { id: { eq: teamId } } }, first: 250 }),
        retryOpts,
      )
      const m = new Map<string, string>()
      for (const l of conn.nodes) {
        m.set(l.name.toLowerCase(), l.id)
      }
      return m
    })()
    cache.set(key, map)
  }
  let m: Map<string, string>
  try {
    m = await map
  } catch (e) {
    cache.delete(key)
    throw e
  }
  const id = m.get(nameOrId.toLowerCase())
  if (!id) {
    throw new LinearAgentError({
      code: 'LABEL_NOT_FOUND',
      message: `label not found: ${nameOrId}`,
      details: { teamId, requested: nameOrId, available: [...m.keys()].sort() },
    })
  }
  return id
}

/**
 * Resolve a list of label names/UUIDs to label UUIDs in input order. Shares
 * the underlying per-team cache so a list of N names triggers at most one SDK
 * call (subsequent name lookups read from the cached map; UUIDs pass through).
 */
export async function resolveLabelIds(
  client: LinearClient,
  workspaceName: string,
  teamId: string,
  namesOrIds: string[],
  retryOpts?: RetryOpts,
): Promise<string[]> {
  return Promise.all(
    namesOrIds.map((n) => resolveLabelId(client, workspaceName, teamId, n, retryOpts)),
  )
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearLabelCache(): void {
  cache.clear()
}
