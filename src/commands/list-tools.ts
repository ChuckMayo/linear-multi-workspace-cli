/**
 * `linmux list-tools` — Phase 4 PLAN 04-02, INT-01.
 *
 * Enumerates every curated and raw command, marking curated→raw mappings.
 * Zero network calls — all data is assembled from static registries.
 *
 * Two-export pattern (S1): default oclif class + named `runListTools` wrapper.
 */
import { Command } from '@oclif/core'
import { listToolsRuntime } from '@/lib/list-tools-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunListToolsArgs {
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runListTools(args: RunListToolsArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'list-tools',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      const result = await listToolsRuntime({ flags: {} })
      // meta.command is injected by runCommand — return only the non-command meta fields
      return { data: result.data, meta: {} }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class ListTools extends Command {
  static override description = 'Enumerate every curated and raw command with curated→raw mappings.'
  static override enableJsonFlag = true
  static override flags = { ...BASE_FLAGS }
  // NO workspace flag — list-tools makes zero network calls

  async run(): Promise<unknown> {
    const { flags } = await this.parse(ListTools)
    const callArgs: RunListToolsArgs = { pretty: flags.pretty }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runListTools(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
