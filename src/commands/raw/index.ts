/**
 * `linear-agent raw <Operation>` — Phase 3 PLAN 03-02.
 *
 * Dispatches any operation in the generated GraphQL registry.
 * Implementation lives in `src/lib/raw-runtime.ts` (two-export pattern S1 —
 * analog: `src/commands/issue/transition.ts:19-95`).
 *
 * This file exports BOTH:
 *   - Named `runRaw` re-export (for tests + future programmatic use)
 *   - Default `RawCommand` oclif class
 *
 * Gate ordering (enforced in runtime):
 *   WSP-06 (workspace selector) BEFORE --allow-mutations BEFORE dispatch.
 */
import { Args, Command, Flags } from '@oclif/core'
import { type RunRawArgs, type RunRawFlags, type RunRawOutput, runRaw } from '@/lib/raw-runtime.js'
import { BASE_FLAGS, runCommand } from '@/lib/workspace-runtime.js'

export type { RunRawArgs, RunRawFlags, RunRawOutput }
export { runRaw }

export default class RawCommand extends Command {
  static override description =
    'Dispatch any operation in the generated GraphQL registry (501 ops).'

  static override examples = [
    '<%= config.bin %> raw Issues --vars \'{"first": 10}\'',
    '<%= config.bin %> raw IssueCreate --workspace acme --allow-mutations --vars \'{"input": {"title": "x", "teamId": "..."}}\'',
    '<%= config.bin %> raw Issues --vars @vars.json',
  ]

  static enableJsonFlag = true

  static override args = {
    operation: Args.string({
      required: true,
      description: 'PascalCase operation name (e.g. Issues, IssueCreate)',
    }),
  }

  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description:
        'Workspace name override (precedence over LINEAR_WORKSPACE env / active default)',
    }),
    'allow-active-workspace-write': Flags.boolean({
      default: false,
      description:
        'Permit mutations against the active workspace without an explicit --workspace selector (WSP-06 opt-in)',
    }),
    'allow-mutations': Flags.boolean({
      default: false,
      description: 'Required for mutation operations — explicit safety gate',
    }),
    vars: Flags.string({
      description: 'Variables as inline JSON or @file.json path (file takes precedence)',
    }),
    // WR-01 fix: --fields was declared, parsed, and never applied. The
    // raw escape hatch dispatches arbitrary GraphQL operations (501 of
    // them) — each has its own response shape, so the per-entity
    // parseFields / project machinery does not generalize. Drop the
    // flag rather than ship documented-but-unimplemented behavior.
    // Agents that need post-execution projection should pipe through
    // jq, or use the typed entity commands (issue list, comment list,
    // etc.) which do honor --fields.
  }

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RawCommand)

    const rawFlags: RunRawFlags = {
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) rawFlags.workspace = flags.workspace
    if (flags['allow-active-workspace-write'])
      rawFlags['allow-active-workspace-write'] = flags['allow-active-workspace-write']
    if (flags['allow-mutations']) rawFlags['allow-mutations'] = flags['allow-mutations']
    if (flags.vars !== undefined) rawFlags.vars = flags.vars

    const runArgs: Parameters<typeof runCommand>[0] = {
      commandPath: 'raw',
      pretty: flags.pretty ?? false,
      handler: (retryOpts) =>
        runRaw({
          args: args as RunRawArgs,
          flags: rawFlags,
          env: process.env,
          retryOptsOverride: retryOpts,
        }),
    }
    if (flags.quiet !== undefined) runArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) runArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) runArgs.retry = flags.retry
    const out = await runCommand(runArgs)

    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
