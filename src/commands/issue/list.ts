/**
 * `linear-agent issue list` — first vertical-slice read command.
 *
 * Implementation lives in `src/lib/issue-list-runtime.ts` (per the same
 * pattern PLAN-04 established for workspace commands). This file exports
 * BOTH the oclif Command class AND a named `runIssueList(args)` function so
 * tests can call the runtime without spawning a subprocess (PATTERNS § "Each
 * `src/commands/<topic>/<verb>.ts` exports BOTH the oclif Command class AND a
 * named `run<Cmd>(args)` async function").
 *
 * Per CONTEXT § `issue list` (First Vertical Slice):
 *   - Filters in Phase 1: --state, --assignee, --team
 *   - Pagination: --limit (default 25, max 100), --cursor (opaque)
 *   - Projection: --fields (preset|csv)
 *   - Workspace selection: --workspace flag honored, otherwise resolver chain
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { issueListRuntime } from '@/lib/issue-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  state?: string
  assignee?: string
  team?: string
  include?: string[]
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runIssueList(args: RunIssueListArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'issue list',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof issueListRuntime>[0]['flags'] = {
        fields: args.fields ?? 'defaults',
      }
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.assignee !== undefined) runtimeFlags.assignee = args.assignee
      if (args.team !== undefined) runtimeFlags.team = args.team
      if (args.include !== undefined) runtimeFlags.include = args.include

      const result = await issueListRuntime({
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

export default class IssueList extends Command {
  static override description =
    'List Linear issues, with --fields, --limit, --cursor, and Phase 1 filters.'
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
    state: Flags.string({ description: 'Filter by workflow state name or ID' }),
    assignee: Flags.string({ description: 'Filter by assignee email, ID, or "me"' }),
    team: Flags.string({ description: 'Filter by team key, ID, or name' }),
    include: Flags.string({
      description:
        'Hydrate related entities in a single GraphQL round-trip (e.g. comments, labels). Available: comments, labels, attachments, subscribers, history.',
      multiple: true,
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(IssueList)
    const callArgs: RunIssueListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.assignee !== undefined) callArgs.assignee = flags.assignee
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.include !== undefined) callArgs.include = flags.include
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runIssueList(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    // Re-emit the parsed envelope for oclif's --json mode.
    return JSON.parse(out.stdout)
  }
}
