import type { ErrorCode } from './codes.js'

/**
 * Canonical numeric exit codes per CONTEXT.md § Exit Code Taxonomy.
 *
 * Stays below 64 to avoid POSIX 125+ shell-reserved codes (clig.dev,
 * Wikipedia § Exit status). Agent runtimes can build retry logic on these
 * because every code is documented and stable.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC: 1,
  USAGE: 2,
  WORKSPACE: 10,
  AUTH: 11,
  VALIDATION: 12,
  LINEAR_API: 13,
  RATELIMITED: 14,
  NETWORK: 15,
} as const

/**
 * Map an `ErrorCode` to its canonical numeric exit code.
 *
 * Implemented as an exhaustive switch with a `_exhaustive: never` guard in
 * the default branch — adding a new code to `ERROR_CODES` without a
 * corresponding case will fail `tsc --noEmit`. This is exactly the
 * "hard-to-skip" property this kernel needs (T-01-03 in the threat model).
 */
export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'WORKSPACE_NOT_RESOLVED':
    case 'WORKSPACE_NOT_FOUND':
    case 'WORKSPACE_REQUIRED_FOR_WRITE':
    case 'WORKSPACE_TOKEN_MISMATCH':
    case 'WORKSPACE_ALREADY_EXISTS':
      return EXIT_CODES.WORKSPACE
    case 'AUTH_INVALID':
    case 'CONFIG_PERMISSIONS_TOO_BROAD':
    case 'CONFIG_NOT_FOUND':
      return EXIT_CODES.AUTH
    case 'VALIDATION_FAILED':
    case 'INVALID_FIELD':
      return EXIT_CODES.VALIDATION
    case 'LINEAR_API_ERROR':
      return EXIT_CODES.LINEAR_API
    case 'RATELIMITED':
      return EXIT_CODES.RATELIMITED
    case 'NETWORK_ERROR':
      return EXIT_CODES.NETWORK
    case 'USAGE_ERROR':
    // Phase 2 PLAN 02-01: validation/usage codes share exit 2 with USAGE_ERROR.
    // The taxonomy reuses existing exit numbers — no new codes.
    case 'VALIDATION_NO_FIELDS':
    case 'WORKFLOW_TEAM_REQUIRED':
    case 'CONFIRMATION_REQUIRED':
    // Phase 3 PLAN 03-01: raw / graphql / batch usage-class errors share exit 2.
    case 'RAW_OPERATION_NOT_FOUND':
    case 'RAW_MUTATION_REQUIRES_FLAG':
    case 'OPERATION_SUBSCRIPTIONS_UNSUPPORTED':
    case 'GRAPHQL_QUERY_FILE_NOT_FOUND':
    case 'BATCH_REQUIRES_YES':
    case 'INVALID_INCLUDE':
      return EXIT_CODES.USAGE
    // Phase 3 PLAN 03-01: validation-class errors join exit 12.
    case 'RAW_VARS_INVALID':
    case 'GRAPHQL_VALIDATION_FAILED':
    case 'BATCH_PLAN_INVALID':
      return EXIT_CODES.VALIDATION
    // Phase 2 PLAN 02-01: entity-not-found codes share exit 13 with LINEAR_API_ERROR.
    case 'WORKFLOW_STATE_NOT_FOUND':
    case 'ISSUE_NOT_FOUND':
    case 'LABEL_NOT_FOUND':
    case 'TEAM_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
    case 'CYCLE_NOT_FOUND':
      return EXIT_CODES.LINEAR_API
    case 'GENERIC_ERROR':
      return EXIT_CODES.GENERIC
    default: {
      // Exhaustiveness guard: TS will complain at this line if any
      // ErrorCode lacks a case branch above.
      const _exhaustive: never = code
      return _exhaustive
    }
  }
}
