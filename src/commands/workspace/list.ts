import { Command } from '@oclif/core'
import { loadConfig } from '@/core/config/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

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
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runWorkspaceList(args: RunWorkspaceListArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'workspace list',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
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
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class WorkspaceList extends Command {
  static override description = 'List registered Linear workspaces'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(WorkspaceList)
    const callArgs: RunWorkspaceListArgs = { pretty: flags.pretty }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWorkspaceList(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
