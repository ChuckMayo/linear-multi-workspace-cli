/**
 * Canonical taxonomy of LinearAgentError codes.
 *
 * Frozen day 1 (Phase 1, plan 01) per CONTEXT.md § Exit Code Taxonomy.
 * Every code listed here MUST have a corresponding branch in `exitCodeFor`
 * (enforced at typecheck time via the `_exhaustive: never` assertion in
 * `exit-codes.ts`).
 *
 * Adding a code:
 *   1. Append the literal string to `ERROR_CODES` below.
 *   2. Add a branch to `exitCodeFor` that returns the appropriate numeric
 *      exit code from the taxonomy (0/1/2/10/11/12/13/14/15). The TS
 *      compiler will refuse to build until you do.
 *   3. Add a test fixture in `test/core/errors.test.ts` (and a snapshot for
 *      the failure envelope in `test/core/output.test.ts` if it is a
 *      user-facing failure mode).
 */
export const ERROR_CODES = [
  // Workspace family — exit 10
  'WORKSPACE_NOT_RESOLVED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_REQUIRED_FOR_WRITE',
  'WORKSPACE_TOKEN_MISMATCH',
  'WORKSPACE_ALREADY_EXISTS',
  // Auth / config family — exit 11
  'AUTH_INVALID',
  'CONFIG_PERMISSIONS_TOO_BROAD',
  'CONFIG_NOT_FOUND',
  // Validation family — exit 12
  'VALIDATION_FAILED',
  'INVALID_FIELD',
  // Linear API family — exit 13
  'LINEAR_API_ERROR',
  // Rate-limit family — exit 14
  'RATELIMITED',
  // Network family — exit 15
  'NETWORK_ERROR',
  // Usage error — exit 2
  'USAGE_ERROR',
  // Generic catch-all — exit 1
  'GENERIC_ERROR',
  // ─── Phase 2 PLAN 02-01 additions ──────────────────────────────────────
  // Validation / usage family — exit 2 (joins USAGE_ERROR)
  'VALIDATION_NO_FIELDS',
  'WORKFLOW_TEAM_REQUIRED',
  'CONFIRMATION_REQUIRED',
  // Linear API family — exit 13 (joins LINEAR_API_ERROR)
  'WORKFLOW_STATE_NOT_FOUND',
  'ISSUE_NOT_FOUND',
  'LABEL_NOT_FOUND',
  'TEAM_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'CYCLE_NOT_FOUND',
  // ─── Phase 3 PLAN 03-01 additions ──────────────────────────────────────
  // Usage family — exit 2 (joins USAGE_ERROR)
  'RAW_OPERATION_NOT_FOUND',
  'RAW_MUTATION_REQUIRES_FLAG',
  'OPERATION_SUBSCRIPTIONS_UNSUPPORTED',
  'GRAPHQL_QUERY_FILE_NOT_FOUND',
  'BATCH_REQUIRES_YES',
  'INVALID_INCLUDE',
  // Validation family — exit 12 (joins VALIDATION_FAILED)
  'RAW_VARS_INVALID',
  'GRAPHQL_VALIDATION_FAILED',
  'BATCH_PLAN_INVALID',
  // ─── Phase 4 additions ──────────────────────────────────────
  // Usage family — exit 2 (joins USAGE_ERROR)
  'DESCRIBE_COMMAND_NOT_FOUND',
  // ─── Phase 5 PLAN 05-02 additions ──────────────────────────────────────
  // Generic family — exit 1 (per RESEARCH §11 Option A; project caps numeric
  // exit codes at 15, so install-skill failures default to GENERIC. Agents
  // branch on `error.code` in the envelope, not on exit code.)
  'INSTALL_SKILL_BUNDLE_NOT_FOUND',
  'INSTALL_SKILL_WRITE_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
