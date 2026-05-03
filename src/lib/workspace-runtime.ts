/**
 * Shared runtime for workspace commands.
 *
 * Lives in `src/lib/` (not `src/commands/workspace/`) because oclif's manifest
 * generator scans every file under `src/commands/` as a command — a helper
 * file there would surface as `linear-agent workspace _shared`. The lib path
 * also matches `tsdown.config.ts`'s entry globs (commands + lib double-star
 * patterns) so the bundle layout stays predictable.
 *
 * Each oclif command file under `src/commands/workspace/` stays under ~50 LOC
 * by delegating envelope formatting, error wrapping, exit-code mapping, and
 * stdout/stderr writing to `runCommand` here. Tests call this helper (and the
 * per-command `run<Cmd>` wrappers in each file) directly without spawning a
 * subprocess.
 *
 * Flow:
 *   1. Caller invokes `runCommand({ commandPath, pretty, handler })`.
 *   2. Handler returns `{ data, meta }` for the success envelope.
 *   3. We wrap the result in the locked Phase 1 envelope (PLAN-01) via
 *      `success(data, { ...meta, command: commandPath })` and return
 *      `{ stdout, stderr?, exitCode: 0 }`.
 *   4. If the handler throws:
 *        - `LinearAgentError` → wrap as `failure(err, { command })`,
 *          exit code via `exitCodeFor(err.code)`.
 *        - Anything else → wrap as `LinearAgentError({ code: 'GENERIC_ERROR',
 *          message: 'Internal error', details: { cause: err.message } })`,
 *          exit code 1. The kernel-wide redactor in `format()` (PLAN-01) is
 *          the safety net that scrubs token-shaped substrings before stdout.
 *
 * This module imports from `@/core/output` and `@/core/errors` only — no
 * filesystem, no SDK, no oclif. The oclif `Command.run()` shim is the
 * thinnest possible glue (`process.stdout.write(out.stdout); process.exit(out.exitCode)`).
 */

import { Flags } from '@oclif/core'
import { exitCodeFor, LinearAgentError } from '@/core/errors/index.js'
import { type FailureMeta, failure, format, type Meta, success } from '@/core/output/index.js'

/**
 * `classifySdkError` lives in `src/core/transport/rate-limit.ts` as of
 * Phase 2 PLAN 02-01 (RAT-03). The Phase 1 message-substring stopgap
 * formerly defined here is GONE; existing import sites (`workspace/add.ts`,
 * `workspace/replace-token.ts`) keep working via this re-export.
 */
export { classifySdkError } from '@/core/transport/index.js'

export const BASE_FLAGS = {
  pretty: Flags.boolean({
    description: 'Human-readable output (default is JSON)',
  }),
}

export interface RunCommandArgs {
  /** Full subcommand path, e.g. `'workspace add'`. Becomes `meta.command`. */
  commandPath: string
  pretty: boolean
  /**
   * Handler returns the success envelope's `{ data, meta }` parts. The shared
   * runtime fills in `meta.command` automatically.
   */
  handler: () => Promise<{
    data: unknown
    meta: Omit<Meta, 'command'>
  }>
}

export interface CommandOutput {
  stdout: string
  stderr?: string
  exitCode: number
}

export async function runCommand(args: RunCommandArgs): Promise<CommandOutput> {
  try {
    const { data, meta } = await args.handler()
    const env = success(data, { ...meta, command: args.commandPath })
    const out = format(env, { pretty: args.pretty })
    return { stdout: out.stdout, stderr: out.stderr, exitCode: 0 }
  } catch (raw) {
    const err = wrapAsLinearAgentError(raw)
    const failureMeta: FailureMeta = { command: args.commandPath }
    const env = failure(err, failureMeta)
    const out = format(env, { pretty: args.pretty })
    return { stdout: out.stdout, stderr: out.stderr, exitCode: exitCodeFor(err.code) }
  }
}

function wrapAsLinearAgentError(raw: unknown): LinearAgentError {
  if (raw instanceof LinearAgentError) return raw
  const cause = raw instanceof Error ? raw.message : String(raw)
  return new LinearAgentError({
    code: 'GENERIC_ERROR',
    message: 'Internal error',
    // The redactor walks `details` before format() stringifies, so any token
    // substring smuggled in via `cause` is scrubbed to `[REDACTED]` before stdout.
    details: { cause },
  })
}

/**
 * Read the env vars our commands consult. Pure for testability — callers
 * inject `process.env` so tests can pass a synthetic env without touching
 * the real one.
 */
export function readEnv(env: NodeJS.ProcessEnv = process.env): {
  LINEAR_WORKSPACE?: string
  LINEAR_API_KEY?: string
} {
  const out: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string } = {}
  if (env.LINEAR_WORKSPACE !== undefined) out.LINEAR_WORKSPACE = env.LINEAR_WORKSPACE
  if (env.LINEAR_API_KEY !== undefined) out.LINEAR_API_KEY = env.LINEAR_API_KEY
  return out
}
