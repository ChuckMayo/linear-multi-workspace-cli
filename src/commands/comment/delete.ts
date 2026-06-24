/**
 * `linmux comment delete <id>` -- Phase 2 PLAN 02-06 Task 2,
 * CMT-01.delete.
 *
 * Write command. Deletes a Linear comment. WSP-06 enforced. NO `--yes` gate
 * -- comments are individually low-stakes; --yes is reserved for irreversible
 * operations (only `issue purge` per CONTEXT line 49). Linear's UI also
 * offers undo for comment deletion.
 *
 * Implementation lives in `src/lib/comment-delete-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCommentDelete(args)` function.
 */
import { Args, Command, Flags } from '@oclif/core'
import { commentDeleteRuntime } from '@/lib/comment-delete-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCommentDeleteArgs {
  id: string
  workspace?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runCommentDelete(args: RunCommentDeleteArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'comment delete',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof commentDeleteRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await commentDeleteRuntime({
        args: { id: args.id },
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

export default class CommentDelete extends Command {
  static override description = 'Delete a Linear comment by UUID.'
  static override enableJsonFlag = true
  static override args = {
    id: Args.string({
      required: true,
      description: 'Comment UUID',
    }),
  }
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    'allow-active-workspace-write': Flags.boolean({
      description:
        'Per-invocation opt-in to use the active default workspace for this write (WSP-06)',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(CommentDelete)
    const callArgs: RunCommentDeleteArgs = {
      id: args.id,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runCommentDelete(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
