/**
 * `linear-agent issue archive <identifier>` -- Phase 2 PLAN 02-05 Task 1,
 * ISS-06.archive.
 *
 * Reversible archive (Linear preserves the issue and lets it be unarchived).
 * Calls `client.archiveIssue(uuid)`. WSP-06 enforced in the runtime BEFORE
 * the SDK call. NO `--yes` flag (CONTEXT line 49 -- archive is reversible
 * via the Linear UI).
 *
 * Implementation lives in `src/lib/issue-archive-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runIssueArchive(args)` function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { issueArchiveRuntime } from '@/lib/issue-archive-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueArchiveArgs {
  identifier: string
  workspace?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runIssueArchive(args: RunIssueArchiveArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'issue archive',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof issueArchiveRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await issueArchiveRuntime({
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

export default class IssueArchive extends Command {
  static override description =
    'Archive a Linear issue (reversible). Linear keeps the issue and supports unarchive.'
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
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssueArchive)
    const callArgs: RunIssueArchiveArgs = {
      identifier: args.identifier,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runIssueArchive(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
