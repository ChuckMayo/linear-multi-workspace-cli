import { Args, Command, Flags } from '@oclif/core'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig, saveConfig, type WorkspaceEntry } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, classifySdkError, runCommand } from './_shared.js'

/**
 * `linear-agent workspace add <name> --token <api-key>`
 *
 * Per WSP-01 / CONTEXT § Workspace Management Commands:
 *   1. Refuses if `<name>` already exists (use `replace-token` to rotate).
 *   2. Validates the token via `client.viewer` → captures `organization.id`.
 *      If the call fails, NOTHING is written to disk (T-01-19 mitigation).
 *   3. If another workspace already has the same `organizationId`, returns a
 *      `data.warning` field but still succeeds (per CONTEXT — same org under
 *      a different alias is intentional, not a bug).
 *   4. Sets the new workspace as active iff this is the first registered.
 *   5. The token NEVER appears in the success envelope. The redactor in
 *      `format()` is the runtime safety net.
 */
export interface RunWorkspaceAddArgs {
  name: string
  token: string
  pretty: boolean
}

export async function runWorkspaceAdd(args: RunWorkspaceAddArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'workspace add',
    pretty: args.pretty,
    handler: async () => {
      const config = loadConfig()

      if (Object.hasOwn(config.workspaces, args.name)) {
        throw LinearAgentError.workspace.alreadyExists(args.name)
      }

      // Construct a synthetic ResolvedWorkspace for the bootstrap token. The
      // resolver isn't used here because the workspace doesn't exist yet —
      // we're creating it with a fresh ad-hoc token.
      const client = createLinearClient({
        name: null,
        token: args.token,
        organizationId: null,
        source: 'api-key-env',
      })

      let orgId: string
      try {
        const viewer = await client.viewer
        // viewer.organization is itself a Promise/getter in @linear/sdk v83
        const org = await viewer.organization
        orgId = org.id
      } catch (e) {
        throw classifySdkError(e)
      }

      // Org-id collision check — succeeds with a warning rather than blocking
      // (per CONTEXT: deliberate same-org aliases are valid use cases).
      let warning: string | undefined
      const collision = Object.values(config.workspaces).find((w) => w.organizationId === orgId)
      if (collision) {
        warning = `organization already registered as ${collision.name}`
      }

      const createdAt = new Date().toISOString()
      const entry: WorkspaceEntry = {
        name: args.name,
        token: args.token,
        organizationId: orgId,
        createdAt,
      }
      const isFirstRegistered = Object.keys(config.workspaces).length === 0
      const isActive = isFirstRegistered

      const next: Config = {
        active: isActive ? args.name : config.active,
        workspaces: { ...config.workspaces, [args.name]: entry },
      }
      saveConfig(next)

      return {
        data: {
          name: args.name,
          organizationId: orgId,
          isActive,
          createdAt,
          ...(warning !== undefined ? { warning } : {}),
        },
        meta: { workspace: args.name },
      }
    },
  })
}

export default class WorkspaceAdd extends Command {
  static override description = 'Register a Linear workspace'
  static override enableJsonFlag = true
  static override args = {
    name: Args.string({ required: true, description: 'Local alias for the workspace' }),
  }
  static override flags = {
    token: Flags.string({
      required: true,
      description: 'Linear personal API key (lin_api_*)',
    }),
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(WorkspaceAdd)
    const out = await runWorkspaceAdd({
      name: args.name,
      token: flags.token,
      pretty: flags.pretty,
    })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    // Return parsed JSON so oclif's --json mode can re-emit it (still goes
    // through our envelope; we just hand back the same object).
    return JSON.parse(out.stdout)
  }
}
