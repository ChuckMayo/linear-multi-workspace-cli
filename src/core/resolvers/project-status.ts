/**
 * Project-status name → ID resolver (Phase 2 PLAN 02-02 Task 2).
 *
 * Resolves a Project's *current status* (e.g. `"On Track"`) to the
 * `ProjectStatus.id` consumed by `client.updateProject(id, { statusId })`.
 *
 * **NOT** to be confused with `client.updateProjectStatus(id, ...)`, which
 * mutates the status DEFINITION (workspace admin operation, out of scope for
 * Phase 2 — see RESEARCH § Pitfall 5). The downstream consumer
 * `project update-status` (Plan 02-07) MUST call `updateProject({ statusId })`
 * with the id this resolver returns, never `updateProjectStatus`.
 *
 * Workspace-scoped (`Map<"${workspace}", Promise<Map<lowercaseName, id>>>`).
 *
 * Error code re-uses `PROJECT_NOT_FOUND` (no separate `PROJECT_STATUS_NOT_FOUND`
 * in the taxonomy from Plan 02-01). The error message disambiguates with
 * `"project status not found: <name>"` and `details.requested` carries the
 * exact input.
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'

const cache = new Map<string, Promise<Map<string, string>>>()

/**
 * Resolve a project-status name (or UUID) to a `ProjectStatus.id` for the
 * active workspace. Throws `PROJECT_NOT_FOUND` (re-used taxonomy) on miss.
 */
export async function resolveProjectStatusId(
  client: LinearClient,
  workspaceName: string,
  nameOrId: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(nameOrId)) return nameOrId
  let map = cache.get(workspaceName)
  if (!map) {
    map = (async () => {
      const conn = await withRateLimitRetry(() => client.projectStatuses({ first: 50 }), retryOpts)
      const m = new Map<string, string>()
      for (const s of conn.nodes) {
        m.set(s.name.toLowerCase(), s.id)
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
      message: `project status not found: ${nameOrId}`,
      details: { workspace: workspaceName, requested: nameOrId, available: [...m.keys()].sort() },
    })
  }
  return id
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearProjectStatusCache(): void {
  cache.clear()
}
