import { Args, Command } from '@oclif/core'
import { updateConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from './_shared.js'

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
}

export async function runWorkspaceUse(args: RunWorkspaceUseArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'workspace use',
    pretty: args.pretty,
    handler: async () => {
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
  })
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
    const out = await runWorkspaceUse({ name: args.name, pretty: flags.pretty })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
