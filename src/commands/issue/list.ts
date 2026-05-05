/**
 * `linear-agent issue list` — first vertical-slice read command.
 *
 * Implementation lives in `src/lib/issue-list-runtime.ts` (per the same
 * pattern PLAN-04 established for workspace commands). This file is the
 * thinnest possible oclif shim:
 *   1. Parse argv flags via oclif.
 *   2. Delegate to `runCommand` with a closure that calls `issueListRuntime`.
 *   3. Write stdout/stderr; exit with the runtime-returned exit code.
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
import { BASE_FLAGS, runCommand } from '@/lib/workspace-runtime.js'

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
    const out = await runCommand({
      commandPath: 'issue list',
      pretty: flags.pretty,
      handler: async () => {
        const runtimeFlags: Parameters<typeof issueListRuntime>[0]['flags'] = {
          fields: flags.fields,
        }
        if (flags.workspace !== undefined) runtimeFlags.workspace = flags.workspace
        if (flags.limit !== undefined) runtimeFlags.limit = flags.limit
        if (flags.cursor !== undefined) runtimeFlags.cursor = flags.cursor
        if (flags.state !== undefined) runtimeFlags.state = flags.state
        if (flags.assignee !== undefined) runtimeFlags.assignee = flags.assignee
        if (flags.team !== undefined) runtimeFlags.team = flags.team
        if (flags.include !== undefined) runtimeFlags.include = flags.include

        const result = await issueListRuntime({
          flags: runtimeFlags,
          env: process.env,
        })
        return { data: result.data, meta: result.meta }
      },
    })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    // Re-emit the parsed envelope for oclif's --json mode.
    return JSON.parse(out.stdout)
  }
}
