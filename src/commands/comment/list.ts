/**
 * `linear-agent comment list` -- Phase 2 PLAN 02-06 Task 1, CMT-01.list.
 *
 * Read command. Lists comments either workspace-wide or scoped to a single
 * issue (--issue ENG-123 or UUID). NO WSP-06 enforcement -- reads are
 * allowed against the active default workspace.
 *
 * Implementation lives in `src/lib/comment-list-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCommentList(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { commentListRuntime } from '@/lib/comment-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCommentListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  issue?: string
  include?: string[]
  pretty: boolean
}

export async function runCommentList(args: RunCommentListArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'comment list',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof commentListRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.issue !== undefined) runtimeFlags.issue = args.issue
      if (args.include !== undefined) runtimeFlags.include = args.include

      const result = await commentListRuntime({
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class CommentList extends Command {
  static override description =
    'List Linear comments. Pass --issue ENG-123 (or UUID) to scope to one issue, otherwise lists workspace-wide.'
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
    issue: Flags.string({
      description: 'Filter to comments on this issue (UUID or ENG-123)',
    }),
    include: Flags.string({
      description:
        'Hydrate related entities in a single GraphQL round-trip (e.g. reactions, parent). Available: reactions, parent.',
      multiple: true,
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(CommentList)
    const callArgs: RunCommentListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.issue !== undefined) callArgs.issue = flags.issue
    if (flags.include !== undefined) callArgs.include = flags.include
    const out = await runCommentList(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
