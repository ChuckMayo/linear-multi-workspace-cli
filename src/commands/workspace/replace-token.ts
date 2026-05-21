import { Args, Command, Flags } from '@oclif/core'
import { createLinearClient } from '@/core/client/index.js'
import { loadConfig, saveConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import {
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

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
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
  /**
   * Test seam — overrides RetryOpts on the transport wrapper. Takes precedence
   * over the operator's --retry N when both are set, so existing tests that
   * pass `{ maxAttempts: 1 }` to disable wait still win.
   */
  retryOptsOverride?: RetryOpts
}

export async function runWorkspaceReplaceToken(
  args: RunWorkspaceReplaceTokenArgs,
): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'workspace replace-token',
    pretty: args.pretty,
    handler: async (retryOpts) => {
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

      // Phase 2 PLAN 02-01: SDK call routes through the transport wrapper
      // for retry + classification. The previous try/catch + classifySdkError
      // is gone; thrown errors are already LinearAgentError instances that
      // flow through `runCommand`.
      //
      // MNT-03 precedence: `args.retryOptsOverride` is the test seam — if a
      // test passes it, it wins. Otherwise the operator's `--retry N` (passed
      // by runCommand as `retryOpts`) is used.
      const effectiveRetryOpts = args.retryOptsOverride ?? retryOpts
      const actualOrgId = await withFetchInterception(async () => {
        const viewer = await withRateLimitRetry(() => client.viewer, effectiveRetryOpts)
        const org = await withRateLimitRetry(() => viewer.organization, effectiveRetryOpts)
        return org.id
      })

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
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
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
    const callArgs: RunWorkspaceReplaceTokenArgs = {
      name: args.name,
      token: flags.token,
      pretty: flags.pretty,
    }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWorkspaceReplaceToken(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
