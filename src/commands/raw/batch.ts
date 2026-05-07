/**
 * `linear-agent raw batch --plan=@file.json` — Phase 3 PLAN 03-05, RAW-05.
 *
 * Safety-gated batch dispatcher. Defaults to --dry-run; requires --yes to execute.
 * Implementation lives in `src/lib/raw-batch-runtime.ts` (two-export pattern S1).
 *
 * This file exports BOTH:
 *   - Named `runRawBatch` re-export (for tests + future programmatic use)
 *   - Default `RawBatchCommand` oclif class
 *
 * Gate ordering (enforced in runtime):
 *   Plan validation → WSP-06 (if mutations) → --allow-mutations → dry-run/yes intent
 *
 * oclif resolves `src/commands/raw/batch.ts` → `linear-agent raw batch` automatically
 * via topic-tree convention.
 */
import { Command, Flags } from '@oclif/core'
import {
  type RunRawBatchFlags,
  type RunRawBatchInput,
  type RunRawBatchOutput,
  runRawBatch,
} from '@/lib/raw-batch-runtime.js'
import { BASE_FLAGS, runCommand } from '@/lib/workspace-runtime.js'

export type { RunRawBatchFlags, RunRawBatchInput, RunRawBatchOutput }
export { runRawBatch }

export default class RawBatchCommand extends Command {
  static override description =
    'Execute a batch of registry operations from a JSON plan file. Default dry-run; --yes required to execute.'

  static override examples = [
    '<%= config.bin %> raw batch --plan=@./plan.json',
    '<%= config.bin %> raw batch --plan=@./plan.json --workspace acme --allow-mutations --yes',
    '<%= config.bin %> raw batch --plan=@./plan.json --no-dry-run --yes --workspace acme --allow-mutations',
  ]

  static enableJsonFlag = true

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
      description: 'Required for plans containing mutation operations — explicit safety gate',
    }),
    plan: Flags.string({
      required: true,
      description: 'Plan file path as @file.json (e.g. --plan=@./plan.json)',
    }),
    'dry-run': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'Print planned operations without executing (default true). Pass --no-dry-run --yes to execute.',
    }),
    yes: Flags.boolean({
      default: false,
      description: 'Confirm execution. Required when --no-dry-run is passed.',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RawBatchCommand)

    const batchFlags: RunRawBatchFlags = {
      plan: flags.plan,
      pretty: flags.pretty,
      'dry-run': flags['dry-run'],
      yes: flags.yes,
      'allow-mutations': flags['allow-mutations'],
      'allow-active-workspace-write': flags['allow-active-workspace-write'],
    }
    if (flags.workspace !== undefined) batchFlags.workspace = flags.workspace

    const runArgs: Parameters<typeof runCommand>[0] = {
      commandPath: 'raw batch',
      pretty: flags.pretty ?? false,
      handler: (retryOpts) =>
        runRawBatch({
          flags: batchFlags,
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
