/**
 * `linmux project update-status <ref> <status>` --
 * Phase 2 PLAN 02-07 Task 2, PRJ-01.update-status.
 *
 * **Multi-word command file**: oclif resolves
 * `src/commands/project/update-status.ts` to `linmux project update-status`
 * (filename-to-command separator is space; the dash inside the filename is
 * preserved verbatim per RESEARCH 02-07 line 252).
 *
 * Sets a project's CURRENT status by calling
 * `client.updateProject(projectId, { statusId })`. The SDK's status-
 * DEFINITION mutator (an admin operation that would rename / recolor /
 * reposition the status row workspace-wide) is explicitly NOT called from
 * this code path -- see RESEARCH § Pitfall 5. The runtime file's header
 * documents the trap; this command is the agent-meaningful "set this
 * project to <status>" path.
 *
 * Implementation lives in `src/lib/project-update-status-runtime.ts` per the
 * Phase 1 PLAN-04 invariant. This file exports BOTH the oclif Command class
 * AND a named `runProjectUpdateStatus(args)` async function so tests can call
 * the runtime without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { projectUpdateStatusRuntime } from '@/lib/project-update-status-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunProjectUpdateStatusArgs {
  ref: string
  status: string
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

export async function runProjectUpdateStatus(
  args: RunProjectUpdateStatusArgs,
): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'project update-status',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof projectUpdateStatusRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await projectUpdateStatusRuntime({
        args: { ref: args.ref, status: args.status },
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

export default class ProjectUpdateStatus extends Command {
  static override description =
    'Set a Linear project\'s current status (e.g. "On Track" -> "At Risk"). Calls updateProject({ statusId }); does NOT mutate the workspace-level status definition.'
  static override enableJsonFlag = true
  static override args = {
    ref: Args.string({
      required: true,
      description: 'Project name or UUID',
    }),
    status: Args.string({
      required: true,
      description: 'Status name (e.g. "At Risk") or UUID',
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
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProjectUpdateStatus)
    const callArgs: RunProjectUpdateStatusArgs = {
      ref: args.ref,
      status: args.status,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runProjectUpdateStatus(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
