/**
 * `linmux whoami` -- Phase 2 PLAN 02-09 Task 1, WHO-01.
 *
 * Alias for `me` -- prints the resolved viewer (user) and organization for
 * the current workspace. Shares `src/lib/me-runtime.ts` with `me`. Both
 * commands emit IDENTICAL envelopes except for `meta.command` (`'me'` vs
 * `'whoami'`). `whoami` exists purely for discoverability per CONTEXT
 * § Specifics line 65 (the pretty-alias pattern).
 *
 * Exports BOTH the default Command class AND a named `runWhoami(args)`
 * function.
 */
import { Command, Flags } from '@oclif/core'
import { type MeInput, meRuntime } from '@/lib/me-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunWhoamiArgs {
  workspace?: string
  fields?: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
  /** WR-07: test seam — see `RunMeArgs.loadConfigOverride`. */
  loadConfigOverride?: MeInput['loadConfigOverride']
  /** WR-07: test seam — see `RunMeArgs.clientFactoryOverride`. */
  clientFactoryOverride?: MeInput['clientFactoryOverride']
}

export async function runWhoami(args: RunWhoamiArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'whoami',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof meRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields

      const meInput: MeInput = {
        flags: runtimeFlags,
        env: process.env,
        // CR-02: forward the operator's --retry N (and the --quiet-gated
        // onRetry writer) into the transport layer that wraps client.viewer
        // and viewer.organization. Mirrors the wiring in `me.ts` so that
        // `whoami` and `me` emit IDENTICAL envelopes except for `meta.command`.
        retryOptsOverride: retryOpts,
      }
      if (args.loadConfigOverride !== undefined)
        meInput.loadConfigOverride = args.loadConfigOverride
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

export default class Whoami extends Command {
  static override description = 'Alias for `me` -- prints the resolved viewer + organization.'
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
    const { flags } = await this.parse(Whoami)
    const callArgs: RunWhoamiArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runWhoami(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
