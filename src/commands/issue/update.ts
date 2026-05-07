/**
 * `linear-agent issue update <identifier>` -- Phase 2 PLAN 02-04 Task 2,
 * ISS-04.
 *
 * Write command. Resolves the issue (identifier or UUID), reads its team
 * for team-scoped resolvers, builds an `IssueUpdateInput` from any of 11
 * partial field flags. WSP-06 enforcement and VALIDATION_NO_FIELDS guard
 * both run in the runtime BEFORE any SDK call.
 *
 * Three label modes co-exist (CONTEXT line 44):
 *   - `--labels p0,bug`        replace mode -> labelIds
 *   - `--add-label p0`  (xN)   add mode     -> addedLabelIds
 *   - `--remove-label legacy`  remove mode  -> removedLabelIds
 *
 * Implementation lives in `src/lib/issue-update-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runIssueUpdate(args)` function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { issueUpdateRuntime } from '@/lib/issue-update-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueUpdateArgs {
  identifier: string
  title?: string
  description?: string
  state?: string
  assignee?: string
  labels?: string
  addLabel?: string[]
  removeLabel?: string[]
  project?: string
  cycle?: string
  priority?: number
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runIssueUpdate(args: RunIssueUpdateArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'issue update',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof issueUpdateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.title !== undefined) runtimeFlags.title = args.title
      if (args.description !== undefined) runtimeFlags.description = args.description
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.assignee !== undefined) runtimeFlags.assignee = args.assignee
      if (args.labels !== undefined) runtimeFlags.labels = args.labels
      if (args.addLabel !== undefined) runtimeFlags.addLabel = args.addLabel
      if (args.removeLabel !== undefined) runtimeFlags.removeLabel = args.removeLabel
      if (args.project !== undefined) runtimeFlags.project = args.project
      if (args.cycle !== undefined) runtimeFlags.cycle = args.cycle
      if (args.priority !== undefined) runtimeFlags.priority = args.priority

      const result = await issueUpdateRuntime({
        args: { identifier: args.identifier },
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

export default class IssueUpdate extends Command {
  static override description =
    'Update a Linear issue. Three label modes co-exist: --labels (replace), --add-label (additive), --remove-label (subtractive). At least one field flag is required.'
  static override enableJsonFlag = true
  static override args = {
    identifier: Args.string({
      required: true,
      description: 'Issue identifier (ENG-123) or UUID',
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
    title: Flags.string({
      description: 'New issue title',
    }),
    description: Flags.string({
      description: 'New issue description (markdown). Pass "" to clear.',
    }),
    state: Flags.string({
      description: 'Workflow state name (e.g. "In Progress") or UUID',
    }),
    assignee: Flags.string({
      description: '"me", email, name, or user UUID',
    }),
    labels: Flags.string({
      description: 'Comma-separated label names or UUIDs (REPLACE mode -- maps to labelIds)',
    }),
    'add-label': Flags.string({
      multiple: true,
      description: 'Label name or UUID to add (ADD mode -- repeatable; maps to addedLabelIds)',
    }),
    'remove-label': Flags.string({
      multiple: true,
      description:
        'Label name or UUID to remove (REMOVE mode -- repeatable; maps to removedLabelIds)',
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
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssueUpdate)
    const callArgs: RunIssueUpdateArgs = {
      identifier: args.identifier,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.title !== undefined) callArgs.title = flags.title
    if (flags.description !== undefined) callArgs.description = flags.description
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.assignee !== undefined) callArgs.assignee = flags.assignee
    if (flags.labels !== undefined) callArgs.labels = flags.labels
    if (flags['add-label'] !== undefined) callArgs.addLabel = flags['add-label']
    if (flags['remove-label'] !== undefined) callArgs.removeLabel = flags['remove-label']
    if (flags.project !== undefined) callArgs.project = flags.project
    if (flags.cycle !== undefined) callArgs.cycle = flags.cycle
    if (flags.priority !== undefined) callArgs.priority = flags.priority
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runIssueUpdate(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
