/**
 * `linear-agent label create` -- Phase 2 PLAN 02-09 Task 2, LBL-01.create.
 *
 * Write command -- the only write in plan 02-09. Creates a Linear issue label
 * scoped to a team. RESEARCH § Pitfall 13: every label gets a `teamId`; the
 * `--team` flag is REQUIRED. Implementation lives in
 * `src/lib/label-create-runtime.ts` per the Phase 1 PLAN-04 invariant.
 *
 * Exports BOTH the default Command class AND a named `runLabelCreate(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { labelCreateRuntime } from '@/lib/label-create-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunLabelCreateArgs {
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  name?: string
  team?: string
  color?: string
  description?: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runLabelCreate(args: RunLabelCreateArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'label create',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof labelCreateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.name !== undefined) runtimeFlags.name = args.name
      if (args.team !== undefined) runtimeFlags.team = args.team
      if (args.color !== undefined) runtimeFlags.color = args.color
      if (args.description !== undefined) runtimeFlags.description = args.description

      const result = await labelCreateRuntime({
        args: {},
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

export default class LabelCreate extends Command {
  static override description =
    'Create a Linear issue label scoped to a team. --name + --team required.'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (required for write unless --allow-active-workspace-write)',
    }),
    'allow-active-workspace-write': Flags.boolean({
      description:
        'Per-invocation opt-in to use the active default workspace for this write (WSP-06)',
    }),
    fields: Flags.string({
      default: 'defaults',
      description: 'Field preset (ids|defaults|full) or comma-separated list',
    }),
    name: Flags.string({
      required: true,
      description: 'Label name',
    }),
    team: Flags.string({
      required: true,
      description: 'Team key (e.g. ENG), UUID, or name',
    }),
    color: Flags.string({
      description: 'Label color (hex, e.g. #ff0000)',
    }),
    description: Flags.string({
      description: 'Label description',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(LabelCreate)
    const callArgs: RunLabelCreateArgs = {
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.name !== undefined) callArgs.name = flags.name
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.color !== undefined) callArgs.color = flags.color
    if (flags.description !== undefined) callArgs.description = flags.description
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runLabelCreate(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
