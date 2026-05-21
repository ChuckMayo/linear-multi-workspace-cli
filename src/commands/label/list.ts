/**
 * `linear-agent label list` -- Phase 2 PLAN 02-09 Task 2, LBL-01.list.
 *
 * Read command. Lists issue labels either workspace-wide or scoped to one
 * team via `--team` (UUID, key, or name). Implementation lives in
 * `src/lib/label-list-runtime.ts`.
 *
 * Exports BOTH the default Command class AND a named `runLabelList(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { labelListRuntime } from '@/lib/label-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunLabelListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  team?: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runLabelList(args: RunLabelListArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'label list',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof labelListRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.team !== undefined) runtimeFlags.team = args.team

      const result = await labelListRuntime({
        flags: runtimeFlags,
        env: process.env,
        retryOptsOverride: retryOpts,
      })
      return { data: result.data, meta: result.meta }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class LabelList extends Command {
  static override description =
    'List Linear issue labels. Pass --team <UUID|key|name> to scope to one team.'
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
    const { flags } = await this.parse(LabelList)
    const callArgs: RunLabelListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runLabelList(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
