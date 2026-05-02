import type { ErrorCode } from './codes.js'

/**
 * Substring patterns that must never appear in a LinearAgentError's
 * `message` field. The redactor (`src/core/redact/redact.ts`) is the
 * primary scrubber — this constructor-level guard is defense in depth
 * for callers that hand-craft messages.
 *
 * Linear PATs are formatted `lin_api_<base64-ish>` (and `lin_oauth_<...>`
 * for OAuth tokens). We forbid the literal prefixes anywhere in the
 * message string, not just at the start, because `Error("Authorization:
 * lin_api_...")` is the exact pattern callers tend to construct.
 */
const FORBIDDEN_TOKEN_PREFIXES = ['lin_api_', 'lin_oauth_'] as const

/** Codes whose default `transient` value is `true`. */
const TRANSIENT_BY_DEFAULT = new Set<ErrorCode>(['RATELIMITED', 'NETWORK_ERROR'])

export type LinearAgentErrorInit = {
  code: ErrorCode
  message: string
  transient?: boolean
  retryAfterMs?: number
  details?: Record<string, unknown>
}

/**
 * The single error class for the kernel. One base class with the code
 * enum, no per-code subclasses (over-engineering — see CONTEXT § specifics).
 *
 * Construction-time guarantees:
 *   - `code` is a member of the frozen taxonomy (TS-enforced).
 *   - `message` does NOT contain a literal `lin_api_` or `lin_oauth_`
 *     substring. This is defense in depth on top of the redactor — if a
 *     caller hand-crafts a message that bakes in a token, the constructor
 *     throws a *plain* `Error` (not a `LinearAgentError`) so the failure
 *     surfaces as a developer bug rather than a user-facing error.
 *   - `transient` defaults to `true` for `RATELIMITED` and `NETWORK_ERROR`,
 *     `false` for everything else. Callers may override.
 */
export class LinearAgentError extends Error {
  override readonly name = 'LinearAgentError'
  readonly code: ErrorCode
  readonly transient: boolean
  readonly retryAfterMs?: number
  readonly details?: Record<string, unknown>

  constructor(init: LinearAgentErrorInit) {
    super(init.message)
    for (const prefix of FORBIDDEN_TOKEN_PREFIXES) {
      if (init.message.includes(prefix)) {
        throw new Error(
          `token-shaped substring forbidden in error message (matched ${prefix}*); use the redactor or strip the token before constructing the error`,
        )
      }
    }
    this.code = init.code
    this.transient = init.transient ?? TRANSIENT_BY_DEFAULT.has(init.code)
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs
    if (init.details !== undefined) this.details = init.details
  }

  // Static family helpers — ergonomic shortcuts for the most common
  // construction patterns. Exact arg shapes at Claude's discretion per
  // PLAN-01 task 1; bias toward terse call sites in command handlers.
  static workspace = {
    notResolved: (detail?: string): LinearAgentError =>
      new LinearAgentError({
        code: 'WORKSPACE_NOT_RESOLVED',
        message: detail ?? 'no workspace could be resolved for this invocation',
      }),
    notFound: (name: string): LinearAgentError =>
      new LinearAgentError({
        code: 'WORKSPACE_NOT_FOUND',
        message: `workspace not found: ${name}`,
        details: { workspace: name },
      }),
    requiredForWrite: (): LinearAgentError =>
      new LinearAgentError({
        code: 'WORKSPACE_REQUIRED_FOR_WRITE',
        message:
          'write commands require an explicit --workspace flag, LINEAR_WORKSPACE env, or --allow-active-workspace-write opt-in',
      }),
    tokenMismatch: (expected: string, got: string): LinearAgentError =>
      new LinearAgentError({
        code: 'WORKSPACE_TOKEN_MISMATCH',
        message: 'token does not match the organizationId stored for this workspace',
        details: { expectedOrganizationId: expected, gotOrganizationId: got },
      }),
    alreadyExists: (name: string): LinearAgentError =>
      new LinearAgentError({
        code: 'WORKSPACE_ALREADY_EXISTS',
        message: `workspace already registered: ${name} (use replace-token to rotate)`,
        details: { workspace: name },
      }),
  } as const

  static auth = {
    invalid: (detail?: string): LinearAgentError =>
      new LinearAgentError({
        code: 'AUTH_INVALID',
        message: detail ?? 'authentication token is invalid or expired',
      }),
    configPermissionsTooBroad: (path: string, mode: string): LinearAgentError =>
      new LinearAgentError({
        code: 'CONFIG_PERMISSIONS_TOO_BROAD',
        message: `config file mode is broader than 0600 (${mode}); run \`chmod 600 ${path}\``,
        details: { path, mode },
      }),
    configNotFound: (path: string): LinearAgentError =>
      new LinearAgentError({
        code: 'CONFIG_NOT_FOUND',
        message: `config file not found: ${path}`,
        details: { path },
      }),
  } as const

  static validation = {
    failed: (detail: string, details?: Record<string, unknown>): LinearAgentError =>
      new LinearAgentError({
        code: 'VALIDATION_FAILED',
        message: detail,
        ...(details !== undefined ? { details } : {}),
      }),
    invalidField: (field: string, allowed?: readonly string[]): LinearAgentError =>
      new LinearAgentError({
        code: 'INVALID_FIELD',
        message: `unknown field: ${field}`,
        details: allowed !== undefined ? { field, allowed: [...allowed] } : { field },
      }),
  } as const

  static linear = {
    apiError: (init: { message: string; details?: Record<string, unknown> }): LinearAgentError =>
      new LinearAgentError({
        code: 'LINEAR_API_ERROR',
        message: init.message,
        ...(init.details !== undefined ? { details: init.details } : {}),
      }),
  } as const

  static rateLimited(retryAfterMs: number, details?: Record<string, unknown>): LinearAgentError {
    return new LinearAgentError({
      code: 'RATELIMITED',
      message: 'Linear rate limit exceeded',
      transient: true,
      retryAfterMs,
      ...(details !== undefined ? { details } : {}),
    })
  }

  static network(detail: string, details?: Record<string, unknown>): LinearAgentError {
    return new LinearAgentError({
      code: 'NETWORK_ERROR',
      message: detail,
      transient: true,
      ...(details !== undefined ? { details } : {}),
    })
  }

  static usage(detail: string): LinearAgentError {
    return new LinearAgentError({ code: 'USAGE_ERROR', message: detail })
  }

  static generic(detail: string): LinearAgentError {
    return new LinearAgentError({ code: 'GENERIC_ERROR', message: detail })
  }
}
