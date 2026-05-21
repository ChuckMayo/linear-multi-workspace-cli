import { Args, Command, Flags } from '@oclif/core'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig, saveConfig, type WorkspaceEntry } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import {
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

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

export async function runWorkspaceAdd(args: RunWorkspaceAddArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'workspace add',
    pretty: args.pretty,
    handler: async (retryOpts) => {
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

      // Phase 2 PLAN 02-01: every SDK call routes through the transport.
      // `withRateLimitRetry` does the classification + retry on
      // RatelimitedLinearError / NetworkLinearError; `withFetchInterception`
      // captures complexity headers for `meta.complexity` (no-op here since
      // workspace add doesn't surface meta beyond `workspace`).
      //
      // MNT-03 precedence: `args.retryOptsOverride` is the test seam — if a
      // test passes it, it wins. Otherwise the operator's `--retry N` (passed
      // by runCommand as `retryOpts`) is used.
      const effectiveRetryOpts = args.retryOptsOverride ?? retryOpts
      const orgId = await withFetchInterception(async () => {
        const viewer = await withRateLimitRetry(() => client.viewer, effectiveRetryOpts)
        // viewer.organization is itself a Promise/getter in @linear/sdk v83
        const org = await withRateLimitRetry(() => viewer.organization, effectiveRetryOpts)
        return org.id
      })

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
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
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
    const callArgs: RunWorkspaceAddArgs = {
      name: args.name,
      token: flags.token,
      pretty: flags.pretty,
    }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWorkspaceAdd(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    // Return parsed JSON so oclif's --json mode can re-emit it (still goes
    // through our envelope; we just hand back the same object).
    return JSON.parse(out.stdout)
  }
}
