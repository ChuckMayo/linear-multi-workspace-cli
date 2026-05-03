/**
 * Cycle reference → ID resolver (Phase 2 PLAN 02-02 Task 2).
 *
 * Translates a user-typed cycle reference into a cycle UUID. Accepts:
 *   - UUID                         — passthrough
 *   - `'current'` / `'0'`          — active cycle
 *   - `'next'` / `'+1'`            — index after active in number-sorted list
 *   - `'previous'` / `'-1'`        — index before active
 *   - `'+N'` / `'-N'`              — arbitrary offset from active index
 *   - cycle.name (case-insensitive) — name lookup
 *
 * Offset math is **index-based** against the team's cycles sorted by `number`
 * ascending. The active cycle's position in that array is the anchor; `+1` is
 * the cycle immediately after, `-1` immediately before, and so on. The plan
 * body's "active.number + 1" wording is a documentation artifact — the
 * canonical contract (per the orchestrator's instructions) is index-based, so
 * a `+1` reference is well-defined even when cycle numbers skip.
 *
 * Cache shape: `Map<"${workspace}:${teamId}", Promise<CycleRow[]>>` (full
 * ordered list). One bulk `team.cycles({ first: 250 })` warms the cache; all
 * ref resolutions then run client-side without further SDK calls.
 *
 * On miss (offset out of range, no active cycle, or unknown name), throws
 * `CYCLE_NOT_FOUND` with `details.availableNumbers` and `details.activeNumber`
 * (the active cycle's `.number`, or `null` if no active cycle exists) so the
 * agent can self-correct.
 */
import type { LinearClient } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/rate-limit.js'
import { UUID_RE } from '@/lib/filter-heuristics.js'

interface CycleRow {
  id: string
  number: number
  name: string | null
  isActive: boolean
}

const cache = new Map<string, Promise<CycleRow[]>>()

/** Matches `+N`, `-N`, and bare `N` integer offsets like `0`, `+1`, `-3`. */
const OFFSET_RE = /^[+-]?\d+$/

/**
 * Resolve a cycle reference (UUID, `current`, `next`, `previous`, `+N`, `-N`,
 * `0`, or cycle name) to a cycle UUID, scoped to one `${workspace}:${teamId}`
 * pair.
 */
export async function resolveCycleId(
  client: LinearClient,
  workspaceName: string,
  teamId: string,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref

  const key = `${workspaceName}:${teamId}`
  let cyclesP = cache.get(key)
  if (!cyclesP) {
    cyclesP = (async () => {
      const team = await withRateLimitRetry(() => client.team(teamId), retryOpts)
      const conn = await withRateLimitRetry(() => team.cycles({ first: 250 }), retryOpts)
      const rows: CycleRow[] = conn.nodes
        .map((c) => ({
          id: c.id,
          number: c.number,
          name: c.name ?? null,
          isActive: c.isActive ?? false,
        }))
        .sort((a, b) => a.number - b.number)
      return rows
    })()
    cache.set(key, cyclesP)
  }
  let cycles: CycleRow[]
  try {
    cycles = await cyclesP
  } catch (e) {
    cache.delete(key)
    throw e
  }

  const activeIdx = cycles.findIndex((c) => c.isActive)
  const findOffset = (delta: number): CycleRow | undefined => {
    if (activeIdx === -1) return undefined
    return cycles[activeIdx + delta]
  }

  let resolved: CycleRow | undefined
  if (ref === 'current') {
    resolved = activeIdx >= 0 ? cycles[activeIdx] : undefined
  } else if (ref === 'next') {
    resolved = findOffset(1)
  } else if (ref === 'previous') {
    resolved = findOffset(-1)
  } else if (OFFSET_RE.test(ref)) {
    resolved = findOffset(Number.parseInt(ref, 10))
  } else {
    resolved = cycles.find((c) => c.name?.toLowerCase() === ref.toLowerCase())
  }

  if (!resolved) {
    throw new LinearAgentError({
      code: 'CYCLE_NOT_FOUND',
      message: `cycle not found: ${ref}`,
      details: {
        teamId,
        requested: ref,
        availableNumbers: cycles.map((c) => c.number),
        activeNumber: activeIdx >= 0 ? (cycles[activeIdx]?.number ?? null) : null,
      },
    })
  }
  return resolved.id
}

/** Test seam — clear the in-memory cache between `it` cases. */
export function _clearCycleCache(): void {
  cache.clear()
}
