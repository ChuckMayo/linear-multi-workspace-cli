/**
 * Type declarations for `scripts/measure-cold-start.mjs`. The script is
 * authored as plain ESM (no TS compile step in the scripts/ folder), but
 * `test/scripts/measure-cold-start.test.ts` imports its pure-logic exports
 * directly. TypeScript's NodeNext resolution picks up this `.d.mts` sibling.
 */

export interface ColdStartArgs {
  tarball: string | undefined
  budget_ms: number
  runs: number
}

export interface ColdStartResult {
  ok: boolean
  runs_ms: number[]
  median_ms: number
  budget_ms: number
  tarball: string
}

export function median(values: number[]): number

export function buildResult(input: {
  runs_ms: number[]
  budget_ms: number
  tarball: string
}): ColdStartResult

export function findTarball(cwd: string): string | null

export function parseArgs(argv: readonly string[]): ColdStartArgs
