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
      return EXIT_CODES.USAGE
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
