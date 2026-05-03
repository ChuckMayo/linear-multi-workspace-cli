/**
 * `linear-agent project update <ref>` -- Phase 2 PLAN 02-07 Task 2,
 * PRJ-01.update.
 *
 * Write command. Resolves a project ref (name or UUID) and applies any subset
 * of partial field flags via `client.updateProject`. WSP-06 enforcement and
 * VALIDATION_NO_FIELDS guard both run BEFORE any SDK call.
 *
 * NOTE: To change a project's CURRENT status, use the dedicated
 * `linear-agent project update-status <ref> <status>` sub-command -- it
 * routes through the same `updateProject({ statusId })` mutation, but the
 * dedicated command keeps the load-bearing operation discoverable + the input
 * shape un-ambiguous (per RESEARCH § Pitfall 5).
 */
import { Args, Command, Flags } from '@oclif/core'
import { projectUpdateRuntime } from '@/lib/project-update-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunProjectUpdateArgs {
  ref: string
  name?: string
  description?: string
  state?: string
  lead?: string
  startDate?: string
  targetDate?: string
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
}

export async function runProjectUpdate(args: RunProjectUpdateArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'project update',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof projectUpdateRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }
      if (args.name !== undefined) runtimeFlags.name = args.name
      if (args.description !== undefined) runtimeFlags.description = args.description
      if (args.state !== undefined) runtimeFlags.state = args.state
      if (args.lead !== undefined) runtimeFlags.lead = args.lead
      if (args.startDate !== undefined) runtimeFlags.startDate = args.startDate
      if (args.targetDate !== undefined) runtimeFlags.targetDate = args.targetDate

      const result = await projectUpdateRuntime({
        args: { ref: args.ref },
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class ProjectUpdate extends Command {
  static override description =
    "Update a Linear project. At least one field flag is required. Use `project update-status` to change the project's current status."
  static override enableJsonFlag = true
  static override args = {
    ref: Args.string({
      required: true,
      description: 'Project name or UUID',
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
    name: Flags.string({
      description: 'New project name',
    }),
    description: Flags.string({
      description: 'New project description (markdown). Pass "" to clear.',
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
    const { args, flags } = await this.parse(ProjectUpdate)
    const callArgs: RunProjectUpdateArgs = {
      ref: args.ref,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.name !== undefined) callArgs.name = flags.name
    if (flags.description !== undefined) callArgs.description = flags.description
    if (flags.state !== undefined) callArgs.state = flags.state
    if (flags.lead !== undefined) callArgs.lead = flags.lead
    if (flags['start-date'] !== undefined) callArgs.startDate = flags['start-date']
    if (flags['target-date'] !== undefined) callArgs.targetDate = flags['target-date']
    const out = await runProjectUpdate(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
