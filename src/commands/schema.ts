/**
 * `linmux schema` — Phase 4 PLAN 04-04, INT-03.
 *
 * Returns the Linear GraphQL schema without making any network calls.
 * Sources the vendored `schema.graphql` via schema-loader.ts (lazy-cached).
 *
 * Default: compact SDL (triple-quoted descriptions stripped) for token efficiency.
 * --full:  SDL with all descriptions included.
 * --json:  Standard introspection JSON (__schema format) for programmatic tooling.
 *
 * No --workspace flag — this command makes zero network calls.
 */
import { Command, Flags } from '@oclif/core'
import { schemaRuntime } from '@/lib/schema-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunSchemaArgs {
  full?: boolean
  json?: boolean
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runSchema(args: RunSchemaArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'schema',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      const result = await schemaRuntime({
        flags: {
          full: args.full,
          json: args.json,
        },
      })
      return { data: result.data, meta: {} }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class Schema extends Command {
  static override description =
    'Return the Linear GraphQL schema as compact SDL (descriptions stripped by default), or as introspection JSON with --json.'

  static override enableJsonFlag = true

  static override flags = {
    ...BASE_FLAGS,
    full: Flags.boolean({
      description:
        'Include type descriptions in the SDL output (default: stripped for token efficiency)',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Return introspection JSON (__schema format) instead of SDL text',
      default: false,
      char: 'j',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(Schema)
    const callArgs: RunSchemaArgs = {
      pretty: flags.pretty,
      full: flags.full,
      json: flags.json,
    }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runSchema(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}
