import { Args, Command } from '@oclif/core'
import { type Config, updateConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from './_shared.js'

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
}

export async function runWorkspaceRemove(args: RunWorkspaceRemoveArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'workspace remove',
    pretty: args.pretty,
    handler: async () => {
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
  })
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
    const out = await runWorkspaceRemove({ name: args.name, pretty: flags.pretty })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
