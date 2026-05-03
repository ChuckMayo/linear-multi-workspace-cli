/**
 * `linear-agent state list` -- Phase 2 PLAN 02-09 Task 1, STA-01.
 *
 * Read command. Lists workflow states either across all teams the viewer can
 * see (no filter) OR scoped to one team via `--team` (UUID, key, or name).
 * Per CONTEXT § Specifics line 116, `--team` is OPTIONAL.
 *
 * Implementation lives in `src/lib/state-list-runtime.ts` per the Phase 1
 * PLAN-04 invariant. Exports BOTH the default Command class AND a named
 * `runStateList(args)` function.
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { stateListRuntime } from '@/lib/state-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunStateListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  team?: string
  pretty: boolean
}

export async function runStateList(args: RunStateListArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'state list',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof stateListRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.team !== undefined) runtimeFlags.team = args.team

      const result = await stateListRuntime({
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class StateList extends Command {
  static override description =
    'List Linear workflow states. Pass --team <UUID|key|name> to scope to one team; otherwise lists all states the viewer can see.'
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
    team: Flags.string({
      description: 'Optional team filter (UUID, key, or name)',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(StateList)
    const callArgs: RunStateListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.team !== undefined) callArgs.team = flags.team
    const out = await runStateList(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
