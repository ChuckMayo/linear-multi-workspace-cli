/**
 * `linear-agent issue transition <identifier> <state>` — Phase 2 PLAN 02-03
 * Task 2, ISS-05.
 *
 * Write command. Resolves the issue (identifier or UUID), reads its team,
 * resolves the state name (or UUID passthrough), and mutates via
 * `client.updateIssue(id, { stateId })`. WSP-06 enforcement runs in the
 * runtime BEFORE any SDK call.
 *
 * Implementation lives in `src/lib/issue-transition-runtime.ts` per the
 * Phase 1 PLAN-04 invariant. This file exports BOTH the oclif Command class
 * AND a named `runIssueTransition(args)` function so tests can call the
 * runtime without spawning a subprocess.
 */
import { Args, Command, Flags } from '@oclif/core'
import { issueTransitionRuntime } from '@/lib/issue-transition-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunIssueTransitionArgs {
  identifier: string
  state: string
  workspace?: string
  fields?: string
  allowActiveWorkspaceWrite?: boolean
  pretty: boolean
}

export async function runIssueTransition(args: RunIssueTransitionArgs): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'issue transition',
    pretty: args.pretty,
    handler: async () => {
      const runtimeFlags: Parameters<typeof issueTransitionRuntime>[0]['flags'] = {}
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.fields !== undefined) runtimeFlags.fields = args.fields
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags.allowActiveWorkspaceWrite = args.allowActiveWorkspaceWrite
      }

      const result = await issueTransitionRuntime({
        args: { identifier: args.identifier, state: args.state },
        flags: runtimeFlags,
        env: process.env,
      })
      return { data: result.data, meta: result.meta }
    },
  })
}

export default class IssueTransition extends Command {
  static override description =
    'Transition a Linear issue to a different workflow state by name or UUID.'
  static override enableJsonFlag = true
  static override args = {
    identifier: Args.string({
      required: true,
      description: 'Issue identifier (ENG-123) or UUID',
    }),
    state: Args.string({
      required: true,
      description: 'Workflow state name (e.g. "In Progress") or UUID',
    }),
  }
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    'allow-active-workspace-write': Flags.boolean({
      description:
        'Per-invocation opt-in to use the active default workspace for this write (WSP-06)',
    }),
    fields: Flags.string({
      description: 'Field preset (ids|defaults|full) or comma-separated list',
      default: 'defaults',
    }),
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(IssueTransition)
    const callArgs: RunIssueTransitionArgs = {
      identifier: args.identifier,
      state: args.state,
      pretty: flags.pretty,
      allowActiveWorkspaceWrite: flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags.fields !== undefined) callArgs.fields = flags.fields
    const out = await runIssueTransition(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
