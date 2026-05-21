/**
 * `linear-agent describe <command>` — Phase 4 PLAN 04-03, INT-02.
 *
 * Returns input JSON Schema (from Zod) + examples for curated commands,
 * and input JSON Schema + SDL fragment for raw GraphQL operations.
 *
 * Zero network calls — introspects local registries only.
 * No --workspace flag (WSP-06 does not apply to local introspection).
 *
 * Disambiguation:
 *   - "issue list" (lowercase or space) → curated command
 *   - "IssueCreate" (PascalCase single token) → raw operation
 *
 * Two-export pattern (S1): named `runDescribe` function + default Command class.
 * Tests target the runtime; this file is the thin oclif adapter.
 */

import { Args, Command } from '@oclif/core'
import { describeRuntime } from '@/lib/describe-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunDescribeArgs {
  command: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runDescribe(args: RunDescribeArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'describe',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      const result = await describeRuntime({
        args: { command: args.command },
        flags: {},
      })
      // meta returned by describeRuntime only has `command`; runCommand injects
      // that automatically, so we pass an empty Omit<Meta, 'command'> here.
      return { data: result.data, meta: {} }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class Describe extends Command {
  static override description =
    'Return input/output JSON Schema and examples for a curated or raw command.'

  static override enableJsonFlag = true

  static override args = {
    command: Args.string({
      description: 'Command id (e.g. "issue list") or raw operation name (e.g. "IssueCreate")',
      required: true,
    }),
  }

  static override flags = {
    ...BASE_FLAGS,
    // No --workspace flag: describe makes zero network calls
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(Describe)
    const callArgs: RunDescribeArgs = {
      command: args.command,
      pretty: flags.pretty,
    }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runDescribe(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
