/**
 * Type declarations for `scripts/smoke-runtime-matrix.mjs`.
 *
 * The script is authored in plain JS so it can be invoked directly via `node`
 * without a build step (release.yml's matrix calls `node scripts/smoke-runtime-matrix.mjs`).
 * This sibling `.d.mts` gives `vitest` / `tsc --noEmit` the type information it
 * needs when the test suite imports the named exports.
 */

export type LaneName =
  | 'plain-bash'
  | 'claude-code-via-skill'
  | 'codex-cli-via-exec'
  | 'gemini-cli-via-exec'

export interface LaneMeta {
  readonly blocking: boolean
  readonly requires: ReadonlyArray<string>
}

export const LANES: Readonly<Record<LaneName, LaneMeta>>

export const RUNTIME_PINS: Readonly<{
  readonly codex: string
  readonly gemini: string
}>

export function redact(
  text: string | null | undefined,
  env?: Record<string, string | undefined>,
): string | null | undefined

export interface ParsedArgs {
  lane: string | undefined
  tarball: string | undefined
  skillPath: string | undefined
  _unknownFlags: string[]
  _help?: boolean
}
export function parseArgs(argv: readonly string[]): ParsedArgs

export function findTarball(cwd: string): string | null

export function parseEnvelopeFromStdout(
  stdout: string,
): Record<string, unknown> | null

export interface SpawnSyncResult {
  status: number | null
  stdout?: string | Buffer
  stderr?: string | Buffer
  signal?: NodeJS.Signals | null
  [k: string]: unknown
}
export type SpawnImpl = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => SpawnSyncResult

export interface FsImpl {
  readFileSync: (path: string, encoding?: string) => string
}

export interface LaneResult {
  ok: boolean
  lane: string
  output?: unknown
  reason?: string
  skipped?: boolean
  stderr?: string
  /** present when lane === 'all' */
  lanes?: LaneResult[]
}

export function runLane(params: {
  lane: string
  tarball?: string
  skillPath?: string
  spawnImpl?: SpawnImpl
  fsImpl?: FsImpl
  env?: Record<string, string | undefined>
}): Promise<LaneResult>
