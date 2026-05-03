/**
 * `linear-agent issue create` — Phase 2 PLAN 02-04 Task 1, ISS-03.
 *
 * Write command. Mints a Linear issue with `--title` + `--team` (the only
 * required flags per CONTEXT line 47) and any of 9 optional fields. WSP-06
 * enforcement and required-flag validation both run in the runtime BEFORE
 * any SDK call.
 *
 * Implementation lives in `src/lib/issue-create-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runIssueCreate(args)` function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Command, Flags } from '@oclif/core'
import { issueCreateRuntime } from '@/lib/issue-create-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueCreateArgs {
  title?: string
  team?: string
  description?: string
  state?: string
  assignee?: string
  labels?: string
  project?: string
  cycle?: string
  priority?: number
  parent?: string
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
}

export async function runIssueCreate(args: RunIssueCreateArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'issue create',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof issueCreateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.title !== undefined) runtimeFlags.title = args.title
      if (args.team !== undefined) runtimeFlags.team = args.team
      if (args.description !== undefined) runtimeFlags.description = args.description
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.assignee !== undefined) runtimeFlags.assignee = args.assignee
      if (args.labels !== undefined) runtimeFlags.labels = args.labels
      if (args.project !== undefined) runtimeFlags.project = args.project
      if (args.cycle !== undefined) runtimeFlags.cycle = args.cycle
      if (args.priority !== undefined) runtimeFlags.priority = args.priority
      if (args.parent !== undefined) runtimeFlags.parent = args.parent

      const result = await issueCreateRuntime({
        args: {},
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class IssueCreate extends Command {
  static override description =
    'Create a Linear issue (--title + --team required; --description, --state, --assignee, --labels, --project, --cycle, --priority, --parent optional).'
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
    title: Flags.string({
      required: true,
      description: 'Issue title (required)',
    }),
    team: Flags.string({
      required: true,
      description: 'Team key (ENG), team name, or team UUID (required)',
    }),
    description: Flags.string({
      description: 'Issue description (markdown)',
    }),
    state: Flags.string({
      description: 'Workflow state name (e.g. "In Progress") or UUID',
    }),
    assignee: Flags.string({
      description: '"me", email, name, or user UUID',
    }),
    labels: Flags.string({
      description: 'Comma-separated label names or UUIDs (replace mode)',
    }),
    project: Flags.string({
      description: 'Project name or UUID',
    }),
    cycle: Flags.string({
      description: 'Cycle ref (current|next|previous|+N|-N|UUID|name)',
    }),
    priority: Flags.integer({
      description: 'Priority (0=no priority, 1=urgent, 2=high, 3=medium, 4=low)',
      min: 0,
      max: 4,
    }),
    parent: Flags.string({
      description: 'Parent issue identifier (ENG-42) or UUID',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(IssueCreate)
    const callArgs: RunIssueCreateArgs = {
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.title !== undefined) callArgs.title = flags.title
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.description !== undefined) callArgs.description = flags.description
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.assignee !== undefined) callArgs.assignee = flags.assignee
    if (flags.labels !== undefined) callArgs.labels = flags.labels
    if (flags.project !== undefined) callArgs.project = flags.project
    if (flags.cycle !== undefined) callArgs.cycle = flags.cycle
    if (flags.priority !== undefined) callArgs.priority = flags.priority
    if (flags.parent !== undefined) callArgs.parent = flags.parent
    const out = await runIssueCreate(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
