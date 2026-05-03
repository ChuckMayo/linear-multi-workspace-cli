/**
 * `linear-agent team list` -- Phase 2 PLAN 02-09 Task 1, TEM-01.list.
 *
 * Read command. Lists workspace-scoped teams. Implementation lives in
 * `src/lib/team-list-runtime.ts` per the Phase 1 PLAN-04 invariant (oclif
 * scans every file under `src/commands/` as a Command class).
 *
 * Exports BOTH the default Command class AND a named `runTeamList(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { teamListRuntime } from '@/lib/team-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunTeamListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  pretty: boolean
}

export async function runTeamList(args: RunTeamListArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'team list',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof teamListRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor

      const result = await teamListRuntime({
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class TeamList extends Command {
  static override description = 'List Linear teams in the resolved workspace.'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
    ...PAGINATION_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(TeamList)
    const callArgs: RunTeamListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    const out = await runTeamList(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
