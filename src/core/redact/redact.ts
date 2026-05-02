/**
 * Token redactor — last-line-of-defense scrubber for Linear PATs.
 *
 * The kernel's `format()` function in `src/core/output/format.ts` calls
 * `redact()` on every envelope before stringifying it. Property-based
 * tests in `test/core/redact.test.ts` (≥200 runs) prove no
 * `lin_api_*` or `lin_oauth_*` substring can survive a round-trip.
 *
 * Why the regex is permissive on length: Linear PATs are currently 40-ish
 * base64url chars after the prefix, but the public format isn't versioned.
 * `[A-Za-z0-9_-]+` matches greedily on token-shaped suffixes — slightly
 * over-aggressive on otherwise-innocuous strings is the right tradeoff for
 * a security boundary (PITFALLS § Pitfalls 3, 4).
 */
export const REDACTED = '[REDACTED]' as const

const TOKEN_PATTERN = /lin_(?:api|oauth)_[A-Za-z0-9_-]+/g

const CIRCULAR_SENTINEL = '[CIRCULAR]' as const

/**
 * Walk an arbitrary value and replace every Linear-PAT-shaped substring
 * inside any string field with `[REDACTED]`. Returns a new value (does
 * not mutate the input). Cycle-safe: revisited objects/arrays return the
 * `[CIRCULAR]` sentinel so the walk is bounded (T-01-04 in the threat
 * model).
 *
 * Type parameter `T` is preserved as a return-type hint, but the runtime
 * value MAY differ from `T` if the input contains cycles (the `[CIRCULAR]`
 * sentinel is a string, not the original object). Callers feeding cyclic
 * inputs should not rely on the static return type past one level.
 */
export function redact<T>(input: T): T {
  return walk(input, new WeakSet<object>()) as T
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.replace(TOKEN_PATTERN, REDACTED)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value as object)) {
    return CIRCULAR_SENTINEL
  }
  seen.add(value as object)
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, seen)
  }
  return out
}
