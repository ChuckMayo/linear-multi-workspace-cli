/**
 * `linear-agent cycle list` -- Phase 2 PLAN 02-08 Task 1, CYC-01.list.
 *
 * Read command. Lists Linear cycles with optional --team filter, --fields,
 * --limit, --cursor. NO WSP-06 enforcement -- reads are allowed against the
 * active default workspace.
 *
 * Implementation lives in `src/lib/cycle-list-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runCycleList(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Command, Flags } from '@oclif/core'
import { PAGINATION_FLAGS } from '@/core/pagination/index.js'
import { cycleListRuntime } from '@/lib/cycle-list-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunCycleListArgs {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  team?: string
  include?: string[]
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runCycleList(args: RunCycleListArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'cycle list',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof cycleListRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.limit !== undefined) runtimeFlags.limit = args.limit
      if (args.cursor !== undefined) runtimeFlags.cursor = args.cursor
      if (args.team !== undefined) runtimeFlags.team = args.team
      if (args.include !== undefined) runtimeFlags.include = args.include

      const result = await cycleListRuntime({
        flags: runtimeFlags,
        env: process.env,
        retryOptsOverride: retryOpts,
      })
      return { data: result.data, meta: result.meta }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class CycleList extends Command {
  static override description =
    'List Linear cycles, optionally filtered to a single team via --team. Supports --fields, --limit, --cursor.'
  static override enableJsonFlag = true
  static override flags = {
    ...BASE_FLAGS,
    ...PAGINATION_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    team: Flags.string({
      description: 'Team key (e.g. "ENG"), name, or UUID -- filters cycles to one team',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
    include: Flags.string({
      description:
        'Hydrate related entities in a single GraphQL round-trip (e.g. issues). Available: issues.',
      multiple: true,
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(CycleList)
    const callArgs: RunCycleListArgs = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.limit !== undefined) callArgs.limit = flags.limit
    if (flags.cursor !== undefined) callArgs.cursor = flags.cursor
    if (flags.team !== undefined) callArgs.team = flags.team
    if (flags.include !== undefined) callArgs.include = flags.include
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runCycleList(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
