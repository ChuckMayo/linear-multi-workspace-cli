/**
 * `linear-agent comment update <id>` -- Phase 2 PLAN 02-06 Task 2, CMT-01.update.
 *
 * Write command. Updates a Linear comment's body. WSP-06 enforcement and
 * VALIDATION_NO_FIELDS guard both run in the runtime BEFORE any SDK call.
 *
 * Implementation lives in `src/lib/comment-update-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCommentUpdate(args)` function.
 */
import { Args, Command, Flags } from '@oclif/core'
import { commentUpdateRuntime } from '@/lib/comment-update-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCommentUpdateArgs {
  id: string
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  body?: string
  pretty: boolean
}

export async function runCommentUpdate(args: RunCommentUpdateArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'comment update',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof commentUpdateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.body !== undefined) runtimeFlags.body = args.body

      const result = await commentUpdateRuntime({
        args: { id: args.id },
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class CommentUpdate extends Command {
  static override description =
    'Update a Linear comment. --body is the only updatable field; pass "" to clear.'
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
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
    body: Flags.string({
      description: 'New comment body (markdown). Pass "" to clear.',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(CommentUpdate)
    const callArgs: RunCommentUpdateArgs = {
      id: args.id,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.body !== undefined) callArgs.body = flags.body
    const out = await runCommentUpdate(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
