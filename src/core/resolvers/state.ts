/**
 * Workflow-state name → ID resolver (Phase 2 PLAN 02-02 Task 1, ISS-05).
 *
 * Translates a user-typed workflow-state name (e.g. `"In Progress"`) to its
 * Linear UUID for the `--state` flag on `issue create`, `issue update`, and
 * `issue transition`. UUID inputs pass through unchanged so callers don't have
 * to pre-classify the shape.
 *
 * Cache shape: `Map<"${workspace}:${teamId}", Promise<Map<lowercaseName, id>>>`.
 *
 * **In-memory only, per CLI invocation.** Per CONTEXT § Pitfall 4: "trades
 * stale-within-one-CLI-call (an irrelevant edge case for one-shot CLI
 * invocations) for zero disk persistence overhead." If a state is renamed
 * mid-process, the cached map is stale; the agent self-corrects on the next
 * invocation. WORKFLOW_STATE_NOT_FOUND errors include `details.available` so
 * the agent can see the cached snapshot.
 *
 * Every SDK call is wrapped in `withRateLimitRetry` from
 * `src/core/transport/rate-limit.ts`, so rate-limit / network retry policy
 * (Plan 02-01 RAT-01) applies uniformly.
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'

const cache = new Map<string, Promise<Map<string, string>>>()

/**
 * Resolve a state-name (or UUID) to a workflow-state UUID, scoped to one
 * `${workspace}:${teamId}` pair.
 */
export async function resolveStateNameToId(
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
        () => client.workflowStates({ filter: { team: { id: { eq: teamId } } }, first: 50 }),
        retryOpts,
      )
      const m = new Map<string, string>()
      for (const s of conn.nodes) {
        m.set(s.name.toLowerCase(), s.id)
      }
      return m
    })()
    cache.set(key, map)
  }
  let m: Map<string, string>
  try {
    m = await map
  } catch (e) {
    // Fetch failed (e.g., transport surfaced a classified LinearAgentError).
    // Drop the rejected promise from the cache so subsequent calls retry the
    // SDK rather than re-throwing the same classified error forever.
    cache.delete(key)
    throw e
  }
  const id = m.get(nameOrId.toLowerCase())
  if (!id) {
    throw new LinearAgentError({
      code: 'WORKFLOW_STATE_NOT_FOUND',
      message: `workflow state not found: ${nameOrId}`,
      details: { teamId, requested: nameOrId, available: [...m.keys()].sort() },
    })
  }
  return id
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearStateCache(): void {
  cache.clear()
}
