import { Args, Command } from '@oclif/core'
import { type Config, updateConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

/**
 * `linear-agent workspace remove <name>`
 *
 * Per WSP-04 / CONTEXT § Workspace Management Commands:
 *   - Deletes the workspace from config.
 *   - If the removed workspace was active, picks the alphabetical-first
 *     remaining workspace as the new active. If none remain, active becomes null.
 *   - NEVER prompts for confirmation (PITFALLS UX § no prompts in v1).
 *   - `WORKSPACE_NOT_FOUND` (exit 10) if the name isn't registered.
 */
export interface RunWorkspaceRemoveArgs {
  name: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runWorkspaceRemove(args: RunWorkspaceRemoveArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'workspace remove',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      let nextActive: string | null = null

      updateConfig((current) => {
        if (!Object.hasOwn(current.workspaces, args.name)) {
          throw LinearAgentError.workspace.notFound(args.name)
        }
        // Build the next workspaces map (omit the removed entry).
        const remaining: Config['workspaces'] = {}
        for (const [k, v] of Object.entries(current.workspaces)) {
          if (k !== args.name) remaining[k] = v
        }

        if (current.active === args.name) {
          // Alphabetical-first remaining, else null.
          const names = Object.keys(remaining).sort()
          nextActive = names[0] ?? null
        } else {
          nextActive = current.active
        }

        return { active: nextActive, workspaces: remaining }
      })

      return {
        data: { removed: args.name, active: nextActive },
        meta: {},
      }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class WorkspaceRemove extends Command {
  static override description = 'Remove a workspace from local config'
  static override enableJsonFlag = true
  static override args = {
    name: Args.string({ required: true, description: 'Name of the workspace to remove' }),
  }
  static override flags = {
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(WorkspaceRemove)
    const callArgs: RunWorkspaceRemoveArgs = { name: args.name, pretty: flags.pretty }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWorkspaceRemove(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
