/**
 * `linear-agent comment create` -- Phase 2 PLAN 02-06 Task 1, CMT-01.create.
 *
 * Write command. Creates a Linear comment with `--issue` (UUID or ENG-123)
 * + `--body`. Optional `--parent <comment-uuid>` for threaded replies.
 *
 * Per RESEARCH 02-06 line 887, CommentCreateInput.issueId accepts a Linear
 * identifier (ENG-123) directly -- the runtime passes the user value through
 * without a client-side resolution round-trip.
 *
 * WSP-06 + required-flag validation both run in the runtime BEFORE any SDK
 * call.
 *
 * Implementation lives in `src/lib/comment-create-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCommentCreate(args)` function.
 */
import { Command, Flags } from '@oclif/core'
import { commentCreateRuntime } from '@/lib/comment-create-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCommentCreateArgs {
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  issue?: string
  body?: string
  parent?: string
  pretty: boolean
}

export async function runCommentCreate(args: RunCommentCreateArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'comment create',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof commentCreateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.issue !== undefined) runtimeFlags.issue = args.issue
      if (args.body !== undefined) runtimeFlags.body = args.body
      if (args.parent !== undefined) runtimeFlags.parent = args.parent

      const result = await commentCreateRuntime({
        args: {},
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class CommentCreate extends Command {
  static override description =
    'Create a comment on a Linear issue. --issue + --body required; --parent optional for threaded replies.'
  static override enableJsonFlag = true
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
    issue: Flags.string({
      required: true,
      description: 'Issue UUID or identifier (ENG-123) to comment on (required)',
    }),
    body: Flags.string({
      required: true,
      description: 'Comment body (markdown) (required)',
    }),
    parent: Flags.string({
      description: 'Parent comment UUID (for threaded replies)',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(CommentCreate)
    const callArgs: RunCommentCreateArgs = {
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.issue !== undefined) callArgs.issue = flags.issue
    if (flags.body !== undefined) callArgs.body = flags.body
    if (flags.parent !== undefined) callArgs.parent = flags.parent
    const out = await runCommentCreate(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
