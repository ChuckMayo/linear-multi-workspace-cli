/**
 * Pagination contract for read commands (KRN-08, ISS-01,
 * PITFALLS § Pitfall 6).
 *
 * Every read command exposes the same triplet of flags via `PAGINATION_FLAGS`:
 *   - `--limit <n>`  — page size, default 25, max 100 (Linear's API cap).
 *   - `--cursor <token>` — opaque pagination token from a previous
 *                          response's `meta.pageInfo.endCursor`.
 *
 * The cursor is OPAQUE: we never decode it, never inspect it, never log it.
 * It travels verbatim from `client.issues({ after })` to the next
 * invocation's `meta.pageInfo.endCursor`. PITFALLS § Pitfall 6 — agents
 * driving pagination can rely on this property.
 *
 * Defense in depth: oclif Flags's `min`/`max` reject out-of-range values at
 * argv parse time (exit 2 from oclif itself), and `parsePagination()` re-
 * validates for callers that bypass oclif (programmatic use, tests).
 */

import { Flags } from '@oclif/core'
import { LinearAgentError } from '../errors/index.js'

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100

export const PAGINATION_FLAGS = {
  limit: Flags.integer({
    description: `Page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
    default: DEFAULT_LIMIT,
    min: 1,
    max: MAX_LIMIT,
  }),
  cursor: Flags.string({
    description: "Opaque cursor from a previous response's meta.pageInfo.endCursor",
  }),
}

export interface PaginationInput {
  limit?: number
  cursor?: string
}

export interface PaginationOutput {
  first: number
  after: string | undefined
}

export function parsePagination(input: PaginationInput): PaginationOutput {
  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new LinearAgentError({
      code: 'USAGE_ERROR',
      message: `--limit must be an integer between 1 and ${MAX_LIMIT}`,
      details: { received: limit, min: 1, max: MAX_LIMIT },
    })
  }
  return { first: limit, after: input.cursor }
}
