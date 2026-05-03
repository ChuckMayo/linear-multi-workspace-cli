/**
 * `linear-agent team get <ref>` -- Phase 2 PLAN 02-09 Task 1, TEM-01.get.
 *
 * Single-entity read. Accepts a UUID, team key (e.g. `ENG`), or team name.
 * Implementation lives in `src/lib/team-get-runtime.ts`.
 *
 * Exports BOTH the default Command class AND a named `runTeamGet(args)`
 * function.
 */
import { Args, Command, Flags } from '@oclif/core'
import { teamGetRuntime } from '@/lib/team-get-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunTeamGetArgs {
  ref: string
  workspace?: string
  fields?: string
  pretty: boolean
}

export async function runTeamGet(args: RunTeamGetArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'team get',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof teamGetRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields

      const result = await teamGetRuntime({
        args: { ref: args.ref },
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class TeamGet extends Command {
  static override description = 'Get a single Linear team by UUID, key (e.g. ENG), or name.'
  static override enableJsonFlag = true
  static override args = {
    ref: Args.string({
      required: true,
      description: 'Team UUID, key (e.g. ENG), or name',
    }),
  }
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(TeamGet)
    const callArgs: RunTeamGetArgs = {
      ref: args.ref,
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    const out = await runTeamGet(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
