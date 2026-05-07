/**
 * `linear-agent project get <ref>` -- Phase 2 PLAN 02-07 Task 1, PRJ-01.get.
 *
 * Single-entity read. Accepts a project name or UUID. UUIDs short-circuit
 * resolveProjectId; names go through the workspace-scoped resolver from
 * Plan 02-02. NO WSP-06 enforcement -- reads are allowed against the active
 * default workspace.
 *
 * Implementation lives in `src/lib/project-get-runtime.ts` per the Phase 1
 * PLAN-04 invariant. This file exports BOTH the oclif Command class AND a
 * named `runProjectGet(args)` async function so tests can call the runtime
 * without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { projectGetRuntime } from '@/lib/project-get-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunProjectGetArgs {
  ref: string
  workspace?: string
  fields?: string
  include?: string[]
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

export async function runProjectGet(args: RunProjectGetArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'project get',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof projectGetRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.include !== undefined) runtimeFlags.include = args.include

      const result = await projectGetRuntime({
        args: { ref: args.ref },
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

export default class ProjectGet extends Command {
  static override description = 'Get a single Linear project by name or UUID.'
  static override enableJsonFlag = true
  static override args = {
    ref: Args.string({
      required: true,
      description: 'Project name or UUID',
    }),
  }
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
    include: Flags.string({
      description:
        'Hydrate related entities in a single GraphQL round-trip (e.g. members, teams). Available: members, teams, projectMilestones, documents.',
      multiple: true,
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProjectGet)
    const callArgs: RunProjectGetArgs = {
      ref: args.ref,
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    if (flags.include !== undefined) callArgs.include = flags.include
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runProjectGet(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
