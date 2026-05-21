import { Args, Command } from '@oclif/core'
import { updateConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

/**
 * `linear-agent workspace use <name>`
 *
 * Per WSP-03: sets `active` to the named workspace; throws
 * `WORKSPACE_NOT_FOUND` if not registered. Idempotent — re-running with the
 * already-active name still succeeds and returns the same envelope.
 */
export interface RunWorkspaceUseArgs {
  name: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runWorkspaceUse(args: RunWorkspaceUseArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'workspace use',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      const next = updateConfig((current) => {
        if (!Object.hasOwn(current.workspaces, args.name)) {
          throw LinearAgentError.workspace.notFound(args.name)
        }
        return { ...current, active: args.name }
      })
      return {
        data: { active: next.active },
        meta: { workspace: args.name },
      }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class WorkspaceUse extends Command {
  static override description = 'Set the active default workspace'
  static override enableJsonFlag = true
  static override args = {
    name: Args.string({ required: true, description: 'Name of the workspace to make active' }),
  }
  static override flags = {
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(WorkspaceUse)
    const callArgs: RunWorkspaceUseArgs = { name: args.name, pretty: flags.pretty }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWorkspaceUse(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
