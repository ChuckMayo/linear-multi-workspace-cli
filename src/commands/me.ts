/**
 * `linear-agent me` -- Phase 2 PLAN 02-09 Task 1, WHO-01.
 *
 * Read command. Prints the resolved viewer (current user) and their
 * organization for the active workspace. Shares `src/lib/me-runtime.ts`
 * with `whoami` -- both commands emit IDENTICAL envelopes except for
 * `meta.command` (`'me'` vs `'whoami'`). `whoami` exists purely for
 * discoverability per CONTEXT § Specifics line 65.
 *
 * Exports BOTH the default Command class AND a named `runMe(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { meRuntime } from '@/lib/me-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunMeArgs {
  workspace?: string
  fields?: string
  pretty: boolean
}

export async function runMe(args: RunMeArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'me',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof meRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields

      const result = await meRuntime({
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class Me extends Command {
  static override description =
    'Print the resolved viewer (user) and organization for the current workspace.'
  static override enableJsonFlag = true
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
    const { flags } = await this.parse(Me)
    const callArgs: RunMeArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    const out = await runMe(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
