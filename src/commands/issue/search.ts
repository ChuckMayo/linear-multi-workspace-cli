/**
 * `linear-agent issue search <query>` -- Phase 2 PLAN 02-05 Task 2, ISS-07.
 *
 * Full-text search via `client.searchIssues(term, vars)`. Read command, no
 * WSP-06. Filter parity with `issue list` (state / assignee / team / label
 * / project / cycle), Linear's snippet metadata projected as a top-level
 * `snippet` field (default on; --no-snippet to drop), --include-archived
 * passthrough.
 *
 * Implementation lives in `src/lib/issue-search-runtime.ts` per the Phase
 * 1 PLAN-04 invariant. This file exports BOTH the oclif Command class AND
 * a named `runIssueSearch(args)` function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { issueSearchRuntime } from '@/lib/issue-search-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueSearchArgs {
  query: string
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  state?: string
  assignee?: string
  team?: string
  label?: string
  project?: string
  cycle?: string
  noSnippet?: boolean
  includeArchived?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runIssueSearch(args: RunIssueSearchArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'issue search',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof issueSearchRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.assignee !== undefined) runtimeFlags.assignee = args.assignee
      if (args.team !== undefined) runtimeFlags.team = args.team
      if (args.label !== undefined) runtimeFlags.label = args.label
      if (args.project !== undefined) runtimeFlags.project = args.project
      if (args.cycle !== undefined) runtimeFlags.cycle = args.cycle
      if (args.noSnippet !== undefined) runtimeFlags.noSnippet = args.noSnippet
      if (args.includeArchived !== undefined) runtimeFlags.includeArchived = args.includeArchived

      const result = await issueSearchRuntime({
        args: { query: args.query },
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

export default class IssueSearch extends Command {
  static override description =
    'Full-text search Linear issues. Surfaces match snippets in metadata; supports the same filter flags as `issue list`.'
  static override enableJsonFlag = true
  static override args = {
    query: Args.string({
      required: true,
      description: 'Full-text search query',
    }),
  }
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
    label: Flags.string({ description: 'Filter by label name or UUID' }),
    project: Flags.string({ description: 'Filter by project name or UUID' }),
    cycle: Flags.string({ description: 'Filter by cycle UUID' }),
    'no-snippet': Flags.boolean({
      description: 'Drop the snippet field from each result (token tightening)',
    }),
    'include-archived': Flags.boolean({
      description: 'Include archived issues in search results (default false)',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssueSearch)
    const callArgs: RunIssueSearchArgs = {
      query: args.query,
      pretty: flags.pretty,
      noSnippet: flags['no-snippet'],
      includeArchived: flags['include-archived'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.assignee !== undefined) callArgs.assignee = flags.assignee
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.label !== undefined) callArgs.label = flags.label
    if (flags.project !== undefined) callArgs.project = flags.project
    if (flags.cycle !== undefined) callArgs.cycle = flags.cycle
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runIssueSearch(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
