/**
 * `linear-agent issue get <identifier>` — Phase 2 PLAN 02-03 Task 1, ISS-02.
 *
 * Single-entity read. Accepts a Linear identifier (`ENG-123`) OR a UUID;
 * shape detection lives in `issue-get-runtime.ts`. Implementation lives in
 * `src/lib/issue-get-runtime.ts` per the Phase 1 PLAN-04 invariant — oclif's
 * manifest scans every file under `src/commands/` as a Command class, so
 * non-Command helpers must live elsewhere (`src/lib/` is the canonical home).
 *
 * Both the oclif Command class AND a named `runIssueGet(args)` function are
 * exported from this file so tests can call the runtime without spawning a
 * subprocess (PATTERNS § "Each `src/commands/<topic>/<verb>.ts` exports BOTH
 * the oclif Command class AND a named `run<Cmd>(args)` async function").
 */
import { Args, Command, Flags } from '@oclif/core'
import { issueGetRuntime } from '@/lib/issue-get-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueGetArgs {
  identifier: string
  workspace?: string
  fields?: string
  pretty: boolean
}

export async function runIssueGet(args: RunIssueGetArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'issue get',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof issueGetRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields

      const result = await issueGetRuntime({
        args: { identifier: args.identifier },
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class IssueGet extends Command {
  static override description = 'Get a single Linear issue by identifier (ENG-123) or UUID.'
  static override enableJsonFlag = true
  static override args = {
    identifier: Args.string({
      required: true,
      description: 'Issue identifier (ENG-123) or UUID',
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
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssueGet)
    const callArgs: RunIssueGetArgs = {
      identifier: args.identifier,
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    const out = await runIssueGet(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
