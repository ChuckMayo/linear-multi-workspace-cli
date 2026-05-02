import { Command } from '@oclif/core'
import { loadConfig } from '@/core/config/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from './_shared.js'

/**
 * `linear-agent workspace list`
 *
 * Per WSP-02 / CONTEXT § Workspace Management Commands:
 *   - Returns `{ workspaces: [{ name, organizationId, isActive, createdAt, lastUsedAt? }] }`.
 *   - Tokens NEVER appear in output.
 *   - Sorted by name for deterministic ordering.
 */
export interface RunWorkspaceListArgs {
  pretty: boolean
}

export async function runWorkspaceList(args: RunWorkspaceListArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'workspace list',
    pretty: args.pretty,
    handler: async () => {
      const config = loadConfig()
      const workspaces = Object.values(config.workspaces)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => ({
          name: w.name,
          organizationId: w.organizationId,
          isActive: config.active === w.name,
          createdAt: w.createdAt,
          ...(w.lastUsedAt !== undefined ? { lastUsedAt: w.lastUsedAt } : {}),
        }))

      return {
        data: { workspaces },
        meta: {},
      }
    },
  })
}

export default class WorkspaceList extends Command {
  static override description = 'List registered Linear workspaces'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(WorkspaceList)
    const out = await runWorkspaceList({ pretty: flags.pretty })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
