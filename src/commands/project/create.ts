/**
 * `linmux project create` -- Phase 2 PLAN 02-07 Task 2, PRJ-01.create.
 *
 * Write command. Required: `--name` + `--teams` (comma-separated team
 * keys/UUIDs/names; >=1). Optional: --description, --state, --lead,
 * --start-date, --target-date.
 *
 * Implementation lives in `src/lib/project-create-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runProjectCreate(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Command, Flags } from '@oclif/core'
import { projectCreateRuntime } from '@/lib/project-create-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunProjectCreateArgs {
  name?: string
  teams?: string
  description?: string
  state?: string
  lead?: string
  startDate?: string
  targetDate?: string
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

export async function runProjectCreate(args: RunProjectCreateArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'project create',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof projectCreateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.name !== undefined) runtimeFlags.name = args.name
      if (args.teams !== undefined) runtimeFlags.teams = args.teams
      if (args.description !== undefined) runtimeFlags.description = args.description
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.lead !== undefined) runtimeFlags.lead = args.lead
      if (args.startDate !== undefined) runtimeFlags.startDate = args.startDate
      if (args.targetDate !== undefined) runtimeFlags.targetDate = args.targetDate

      const result = await projectCreateRuntime({
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

export default class ProjectCreate extends Command {
  static override description =
    'Create a Linear project (--name + --teams required; --description, --state, --lead, --start-date, --target-date optional).'
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
    name: Flags.string({
      required: true,
      description: 'Project name (required)',
    }),
    teams: Flags.string({
      required: true,
      description:
        'Comma-separated team keys (ENG), names (Engineering), or UUIDs; at least one required',
    }),
    description: Flags.string({
      description: 'Project description (markdown)',
    }),
    state: Flags.string({
      description:
        "Project state ('planned' | 'started' | 'paused' | 'completed' | 'canceled' | 'backlog')",
    }),
    lead: Flags.string({
      description: '"me", email, name, or user UUID',
    }),
    'start-date': Flags.string({
      description: 'Project start date (ISO 8601, e.g. 2026-10-01)',
    }),
    'target-date': Flags.string({
      description: 'Project target date (ISO 8601, e.g. 2026-12-31)',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(ProjectCreate)
    const callArgs: RunProjectCreateArgs = {
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.name !== undefined) callArgs.name = flags.name
    if (flags.teams !== undefined) callArgs.teams = flags.teams
    if (flags.description !== undefined) callArgs.description = flags.description
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.lead !== undefined) callArgs.lead = flags.lead
    if (flags['start-date'] !== undefined) callArgs.startDate = flags['start-date']
    if (flags['target-date'] !== undefined) callArgs.targetDate = flags['target-date']
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runProjectCreate(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
