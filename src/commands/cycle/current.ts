/**
 * `linear-agent cycle current --team <ref>` -- Phase 2 PLAN 02-08 Task 1,
 * CYC-01.current.
 *
 * Single-entity read. Fetches the active cycle for a specific team. The
 * `--team` flag is REQUIRED -- the runtime throws WORKFLOW_TEAM_REQUIRED
 * (exit 2) BEFORE any SDK call when --team is absent. We deliberately do
 * NOT mark the oclif flag as `required: true` because that would surface a
 * generic oclif USAGE message rather than the structured agent-readable
 * error envelope.
 *
 * NO WSP-06 enforcement -- reads are allowed against the active default
 * workspace.
 *
 * Implementation lives in `src/lib/cycle-current-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCycleCurrent(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Command, Flags } from '@oclif/core'
import { cycleCurrentRuntime } from '@/lib/cycle-current-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCycleCurrentArgs {
  workspace?: string
  fields?: string
  team?: string
  pretty: boolean
}

export async function runCycleCurrent(args: RunCycleCurrentArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'cycle current',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof cycleCurrentRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.team !== undefined) runtimeFlags.team = args.team

      const result = await cycleCurrentRuntime({
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class CycleCurrent extends Command {
  static override description = 'Get the active cycle for a team. --team is REQUIRED.'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    team: Flags.string({
      description: 'Team key (e.g. "ENG"), name, or UUID -- REQUIRED',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(CycleCurrent)
    const callArgs: RunCycleCurrentArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.team !== undefined) callArgs.team = flags.team
    const out = await runCycleCurrent(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
