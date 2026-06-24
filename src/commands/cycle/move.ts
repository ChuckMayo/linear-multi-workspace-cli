/**
 * `linmux cycle move <issue-ref> --to <cycle-ref>` --
 * Phase 2 PLAN 02-08 Task 2, CYC-01.move.
 *
 * Write command. Moves a Linear issue to a different cycle. Linear has NO
 * dedicated "move cycle" mutation; cycle is a property on Issue. The runtime
 * calls `client.updateIssue(issueId, { cycleId })`.
 *
 * `<cycle-ref>` accepts 7 shapes via the cycle resolver from Plan 02-02
 * (UUID, +N/-N/0, current/next/previous, or cycle name).
 *
 * Implementation lives in `src/lib/cycle-move-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCycleMove(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { cycleMoveRuntime } from '@/lib/cycle-move-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCycleMoveArgs {
  issue: string
  to: string
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

export async function runCycleMove(args: RunCycleMoveArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'cycle move',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof cycleMoveRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await cycleMoveRuntime({
        args: { issue: args.issue, to: args.to },
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

export default class CycleMove extends Command {
  static override description =
    'Move a Linear issue to a different cycle. Calls updateIssue({ cycleId }); cycle is a property on Issue.'
  static override enableJsonFlag = true
  static override args = {
    issue: Args.string({
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
    to: Flags.string({
      required: true,
      description: 'Cycle ref: UUID, +N/-N/0, current/next/previous, or cycle name',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(CycleMove)
    const callArgs: RunCycleMoveArgs = {
      issue: args.issue,
      to: flags.to,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runCycleMove(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
