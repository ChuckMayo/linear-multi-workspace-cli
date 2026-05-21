/**
 * `linear-agent me` -- Phase 2 PLAN 02-09 Task 1, WHO-01.
 *
 * Read command. Prints the resolved viewer (current user) and their
 * organization for the active workspace. Shares `src/lib/me-runtime.ts`
 * with `whoami` -- both commands emit IDENTICAL envelopes except for
 * `meta.command` (`'me'` vs `'whoami'`). `whoami` exists purely for
 * discoverability per CONTEXT § Specifics line 65.
 *
 * Exports BOTH the default Command class AND a named `runMe(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { type MeInput, meRuntime } from '@/lib/me-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunMeArgs {
  workspace?: string
  fields?: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
  /**
   * WR-07: test seam — forward an injected config loader into meRuntime so
   * `runMe` can be exercised end-to-end in unit tests without touching the
   * real on-disk config. Production callers pass nothing.
   */
  loadConfigOverride?: MeInput['loadConfigOverride']
  /**
   * WR-07: test seam — forward an injected client factory into meRuntime so
   * `runMe` can be exercised end-to-end in unit tests without spinning up a
   * real `LinearClient`. Production callers pass nothing.
   */
  clientFactoryOverride?: MeInput['clientFactoryOverride']
}

export async function runMe(args: RunMeArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'me',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof meRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields

      const meInput: MeInput = {
        flags: runtimeFlags,
        env: process.env,
        // MNT-03: forward the operator's --retry N (and the --quiet-gated
        // onRetry writer) into the transport layer that wraps client.viewer
        // and viewer.organization.
        retryOptsOverride: retryOpts,
      }
      if (args.loadConfigOverride !== undefined) meInput.loadConfigOverride = args.loadConfigOverride
      if (args.clientFactoryOverride !== undefined)
        meInput.clientFactoryOverride = args.clientFactoryOverride
      const result = await meRuntime(meInput)
      return { data: result.data, meta: result.meta }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class Me extends Command {
  static override description =
    'Print the resolved viewer (user) and organization for the current workspace.'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Me)
    const callArgs: RunMeArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runMe(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
