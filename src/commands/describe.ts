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
}

export async function runDescribe(args: RunDescribeArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'describe',
    pretty: args.pretty,
    handler: async () => {
      const result = await describeRuntime({
        args: { command: args.command },
        flags: {},
      })
      // meta returned by describeRuntime only has `command`; runCommand injects
      // that automatically, so we pass an empty Omit<Meta, 'command'> here.
      return { data: result.data, meta: {} }
    },
  })
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
    const out = await runDescribe({
      command: args.command,
      pretty: flags.pretty,
    })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
