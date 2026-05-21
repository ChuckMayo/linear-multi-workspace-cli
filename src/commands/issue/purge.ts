/**
 * `linear-agent issue purge <identifier> --yes` -- Phase 2 PLAN 02-05
 * Task 1, ISS-06.purge.
 *
 * PERMANENT delete (calls `client.deleteIssue(uuid, { permanentlyDelete:
 * true })`). REQUIRES `--yes`; without it the runtime throws
 * CONFIRMATION_REQUIRED (exit 2) BEFORE any SDK call (T-02-22 mitigation).
 *
 * WSP-06 enforced in the runtime BEFORE the confirmation gate, so a missing
 * --workspace surfaces as WORKSPACE_REQUIRED_FOR_WRITE rather than
 * CONFIRMATION_REQUIRED -- the workspace gate is the more dangerous mistake.
 *
 * Implementation lives in `src/lib/issue-purge-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runIssuePurge(args)` function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { issuePurgeRuntime } from '@/lib/issue-purge-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssuePurgeArgs {
  identifier: string
  workspace?: string
  yes?: boolean
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runIssuePurge(args: RunIssuePurgeArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'issue purge',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof issuePurgeRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.yes !== undefined) runtimeFlags.yes = args.yes
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await issuePurgeRuntime({
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

export default class IssuePurge extends Command {
  static override description =
    'PERMANENTLY delete a Linear issue. Irreversible. Requires --yes to confirm.'
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
    yes: Flags.boolean({
      description: 'Confirm permanent deletion (REQUIRED for purge)',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssuePurge)
    const callArgs: RunIssuePurgeArgs = {
      identifier: args.identifier,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
      yes: flags.yes,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runIssuePurge(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
