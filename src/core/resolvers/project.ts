/**
 * Project name → ID resolver (Phase 2 PLAN 02-02 Task 2).
 *
 * Translates a user-typed project name (e.g. `"Roadmap Q1"`) to its Linear
 * project UUID. UUID inputs pass through unchanged. Project names are
 * workspace-scoped per RESEARCH § Pitfall 5 — the cache key is `${workspace}`.
 *
 * Cache shape: `Map<"${workspace}", Promise<Map<lowercaseName, id>>>`.
 *
 * One bulk `client.projects({ first: 250 })` warms the cache; subsequent name
 * lookups read from memory. This intentionally trades a one-time bulk fetch
 * for the ability to populate `details.available` on a miss without a second
 * round-trip — agents see the workspace's cached project names and can self-
 * correct.
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'

const cache = new Map<string, Promise<Map<string, string>>>()

/**
 * Resolve a project name (or UUID) to a project UUID for the active
 * workspace. Throws `PROJECT_NOT_FOUND` on miss with the cached project name
 * list so the agent can self-correct.
 */
export async function resolveProjectId(
  client: LinearClient,
  workspaceName: string,
  nameOrId: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(nameOrId)) return nameOrId
  let map = cache.get(workspaceName)
  if (!map) {
    map = (async () => {
      const conn = await withRateLimitRetry(() => client.projects({ first: 250 }), retryOpts)
      const m = new Map<string, string>()
      for (const p of conn.nodes) {
        m.set(p.name.toLowerCase(), p.id)
      }
      return m
    })()
    cache.set(workspaceName, map)
  }
  let m: Map<string, string>
  try {
    m = await map
  } catch (e) {
    cache.delete(workspaceName)
    throw e
  }
  const id = m.get(nameOrId.toLowerCase())
  if (!id) {
    throw new LinearAgentError({
      code: 'PROJECT_NOT_FOUND',
      message: `project not found: ${nameOrId}`,
      details: { workspace: workspaceName, requested: nameOrId, available: [...m.keys()].sort() },
    })
  }
  return id
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearProjectCache(): void {
  cache.clear()
}
