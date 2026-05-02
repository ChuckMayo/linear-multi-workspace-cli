import { Args, Command, Flags } from '@oclif/core'
import { createLinearClient } from '@/core/client/index.js'
import { loadConfig, saveConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { BASE_FLAGS, type CommandOutput, classifySdkError, runCommand } from './_shared.js'

/**
 * `linear-agent workspace replace-token <name> --token <new-key>`
 *
 * Per WSP-05 / CONTEXT § Workspace Management Commands:
 *   1. `WORKSPACE_NOT_FOUND` if `<name>` isn't registered.
 *   2. Validates the new token via `client.viewer` → captures
 *      `viewer.organization.id`.
 *   3. If the captured org id does not match the stored `organizationId`,
 *      throws `WORKSPACE_TOKEN_MISMATCH` (T-01-20). Config is NOT modified.
 *   4. SDK errors classified via `classifySdkError` (401 → AUTH_INVALID,
 *      network → NETWORK_ERROR, else LINEAR_API_ERROR).
 *   5. The new token never appears in the success envelope.
 */
export interface RunWorkspaceReplaceTokenArgs {
  name: string
  token: string
  pretty: boolean
}

export async function runWorkspaceReplaceToken(
  args: RunWorkspaceReplaceTokenArgs,
): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'workspace replace-token',
    pretty: args.pretty,
    handler: async () => {
      const config = loadConfig()
      const entry = config.workspaces[args.name]
      if (!entry) {
        throw LinearAgentError.workspace.notFound(args.name)
      }
      const expectedOrgId = entry.organizationId

      // Validate the new token against Linear before persisting.
      const client = createLinearClient({
        name: null,
        token: args.token,
        organizationId: null,
        source: 'api-key-env',
      })

      let actualOrgId: string
      try {
        const viewer = await client.viewer
        const org = await viewer.organization
        actualOrgId = org.id
      } catch (e) {
        throw classifySdkError(e)
      }

      if (actualOrgId !== expectedOrgId) {
        throw LinearAgentError.workspace.tokenMismatch(expectedOrgId, actualOrgId)
      }

      // Atomic swap: load → mutate token → save (preserve every other field).
      const next = {
        ...config,
        workspaces: {
          ...config.workspaces,
          [args.name]: { ...entry, token: args.token },
        },
      }
      saveConfig(next)

      return {
        data: { name: args.name, organizationId: expectedOrgId },
        meta: { workspace: args.name },
      }
    },
  })
}

export default class WorkspaceReplaceToken extends Command {
  static override description = 'Rotate the API token for a registered workspace'
  static override enableJsonFlag = true
  static override args = {
    name: Args.string({ required: true, description: 'Name of the workspace to rotate' }),
  }
  static override flags = {
    token: Flags.string({
      required: true,
      description: 'New Linear personal API key (lin_api_*)',
    }),
    ...BASE_FLAGS,
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(WorkspaceReplaceToken)
    const out = await runWorkspaceReplaceToken({
      name: args.name,
      token: flags.token,
      pretty: flags.pretty,
    })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
