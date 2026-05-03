/**
 * Team key/name → ID resolver (Phase 2 PLAN 02-02 Task 1).
 *
 * Translates a user-typed team key (`ENG`) or name (`Engineering`) to its
 * Linear team UUID. UUID inputs pass through unchanged.
 *
 * Cache shape: `Map<"${workspace}", Promise<{ byKey, byName }>>`.
 * Workspace-scoped: a single `client.teams({ first: 250 })` request populates
 * BOTH the by-key and by-name lookup tables in one round-trip, so subsequent
 * resolutions in the same invocation read from cache.
 *
 * Lookup strategy (case-insensitive):
 *   1. UUID passthrough.
 *   2. If input matches `TEAM_KEY_RE` (e.g. `ENG`), check `byKey` first, fall
 *      back to `byName` (so a rare team named "ENG" still resolves).
 *   3. Otherwise check `byName` first, fall back to `byKey`.
 *
 * Every SDK call is wrapped in `withRateLimitRetry` from
 * `src/core/transport/rate-limit.ts`.
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { TEAM_KEY_RE, UUID_RE } from '@/lib/filter-heuristics.js'

interface TeamCacheEntry {
  byKey: Map<string, string>
  byName: Map<string, string>
}

const cache = new Map<string, Promise<TeamCacheEntry>>()

/**
 * Resolve a team key, name, or UUID to a team UUID for the active workspace.
 */
export async function resolveTeamId(
  client: LinearClient,
  workspaceName: string,
  keyOrIdOrName: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(keyOrIdOrName)) return keyOrIdOrName
  let entry = cache.get(workspaceName)
  if (!entry) {
    entry = (async () => {
      const conn = await withRateLimitRetry(() => client.teams({ first: 250 }), retryOpts)
      const byKey = new Map<string, string>()
      const byName = new Map<string, string>()
      for (const t of conn.nodes) {
        byKey.set(t.key.toLowerCase(), t.id)
        byName.set(t.name.toLowerCase(), t.id)
      }
      return { byKey, byName }
    })()
    cache.set(workspaceName, entry)
  }
  let resolved: TeamCacheEntry
  try {
    resolved = await entry
  } catch (e) {
    cache.delete(workspaceName)
    throw e
  }
  const lower = keyOrIdOrName.toLowerCase()
  const isKeyShape = TEAM_KEY_RE.test(keyOrIdOrName)
  const id = isKeyShape
    ? (resolved.byKey.get(lower) ?? resolved.byName.get(lower))
    : (resolved.byName.get(lower) ?? resolved.byKey.get(lower))
  if (!id) {
    throw new LinearAgentError({
      code: 'TEAM_NOT_FOUND',
      message: `team not found: ${keyOrIdOrName}`,
      details: {
        workspace: workspaceName,
        requested: keyOrIdOrName,
        availableKeys: [...resolved.byKey.keys()].sort(),
        availableNames: [...resolved.byName.keys()].sort(),
      },
    })
  }
  return id
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearTeamCache(): void {
  cache.clear()
}
