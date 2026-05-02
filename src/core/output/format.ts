import pc from 'picocolors'
import { redact } from '@/core/redact/index.js'
import type { Envelope, FailureEnvelope, SuccessEnvelope } from './envelope.js'

/**
 * format() — turns an envelope into stdout (always) + optional stderr (only
 * on `pretty: true` failures). Always invokes the redactor first so PAT
 * substrings cannot leak through stringify.
 *
 * Returning `{ stdout, stderr? }` rather than calling `process.stdout.write`
 * directly keeps `format` pure. The caller (the oclif command runner)
 * decides where to write — easier to test, easier to compose with `--debug`
 * mirroring later.
 *
 * Pretty rendering layout:
 *   - Success: dim header "<command> · <workspace>", then `JSON.stringify
 *     (data, null, 2)` so the agent-friendly shape is still inspectable.
 *   - Failure: bold red "error: <code> — <message>", then key/value lines
 *     for each detail. A one-liner mirrors to stderr for humans piping
 *     stdout to a JSON parser.
 *
 * Color is gated on `pc.isColorSupported`; tests set `process.env.NO_COLOR
 * = '1'` (which picocolors honors) so snapshots stay portable across
 * environments (T-01-03 mitigation: snapshots committed, CI fails on drift).
 */
export type FormatOptions = { pretty: boolean }
export type FormatOutput = { stdout: string; stderr?: string }

export function format(envelope: Envelope, opts: FormatOptions): FormatOutput {
  const redacted = redact(envelope) as Envelope

  if (!opts.pretty) {
    return { stdout: `${JSON.stringify(redacted)}\n` }
  }

  if (redacted.ok) {
    return { stdout: renderSuccessPretty(redacted) }
  }
  return {
    stdout: renderFailurePretty(redacted),
    stderr: renderFailureStderrSummary(redacted),
  }
}

function renderSuccessPretty(env: SuccessEnvelope): string {
  const lines: string[] = []
  const header = `${env.meta.command}${env.meta.workspace ? ` · ${env.meta.workspace}` : ''}`
  lines.push(pc.dim(`# ${header}`))
  lines.push(JSON.stringify(env.data, null, 2))
  if (env.meta.pageInfo) {
    const pi = env.meta.pageInfo
    lines.push(
      pc.dim(
        `# pageInfo: hasNextPage=${pi.hasNextPage}${pi.endCursor ? ` endCursor=${pi.endCursor}` : ''}`,
      ),
    )
  }
  return `${lines.join('\n')}\n`
}

function renderFailurePretty(env: FailureEnvelope): string {
  const lines: string[] = []
  lines.push(`${pc.bold(pc.red('error:'))} ${env.error.code} — ${env.error.message}`)
  if (env.error.transient) {
    const retry =
      env.error.retryAfterMs !== undefined ? ` (retry after ${env.error.retryAfterMs}ms)` : ''
    lines.push(pc.dim(`# transient${retry} — safe to retry`))
  }
  if (env.error.details) {
    for (const [k, v] of Object.entries(env.error.details)) {
      lines.push(`  ${pc.dim(k)}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  lines.push(pc.dim('# see stderr for one-liner; full envelope on stdout above'))
  return `${lines.join('\n')}\n`
}

function renderFailureStderrSummary(env: FailureEnvelope): string {
  return `${pc.bold(pc.red('error:'))} ${env.error.code} — ${env.error.message}\n`
}
