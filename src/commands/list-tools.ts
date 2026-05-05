/**
 * `linear-agent list-tools` — Phase 4 PLAN 04-02, INT-01.
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
}

export async function runListTools(args: RunListToolsArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'list-tools',
    pretty: args.pretty,
    handler: async () => {
      const result = await listToolsRuntime({ flags: {} })
      // meta.command is injected by runCommand — return only the non-command meta fields
      return { data: result.data, meta: {} }
    },
  })
}

export default class ListTools extends Command {
  static override description = 'Enumerate every curated and raw command with curated→raw mappings.'
  static override enableJsonFlag = true
  static override flags = { ...BASE_FLAGS }
  // NO workspace flag — list-tools makes zero network calls

  async run(): Promise<unknown> {
    const { flags } = await this.parse(ListTools)
    const out = await runListTools({ pretty: flags.pretty })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
