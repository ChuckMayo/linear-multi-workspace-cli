/**
 * Levenshtein distance and closest-name suggester.
 *
 * Extracted from `raw-runtime.ts` (Phase 3) for shared use by:
 *   - `raw-runtime.ts` — "did you mean X?" suggestions on RAW_OPERATION_NOT_FOUND
 *   - `describe-runtime.ts` (Phase 4) — DESCRIBE_COMMAND_NOT_FOUND suggestions
 *
 * The Int32Array flat-row-major implementation avoids biome's `noNonNullAssertion`
 * warnings that a 2D array approach would trigger.
 */

/**
 * Return the top `limit` closest names to `missing` by Levenshtein distance.
 * Comparison is case-insensitive so "issues" matches "Issues" with distance 0.
 */
export function suggestClosest(missing: string, names: string[], limit = 3): string[] {
  return names
    .map((n) => ({ name: n, d: levenshtein(missing.toLowerCase(), n.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.name)
}

/**
 * Simple iterative Levenshtein distance.
 * Uses flat typed array to avoid biome noNonNullAssertion warnings on 2D indexing.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  // Flat row-major array: dp[i][j] = dp[i * (n+1) + j]
  const dp = new Int32Array((m + 1) * (n + 1))
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1
      const del = (dp[(i - 1) * (n + 1) + j] ?? i) + 1
      const ins = (dp[i * (n + 1) + (j - 1)] ?? j) + 1
      const rep = (dp[(i - 1) * (n + 1) + (j - 1)] ?? i + j) + sub
      dp[i * (n + 1) + j] = Math.min(del, ins, rep)
    }
  }
  return dp[m * (n + 1) + n] ?? 0
}
