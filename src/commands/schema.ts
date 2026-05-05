/**
 * `linear-agent schema` — Phase 4 PLAN 04-04, INT-03.
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

export async function runSchema(args: {
  full?: boolean
  json?: boolean
  pretty: boolean
}): Promise<CommandOutput> {
  return runCommand({
    commandPath: 'schema',
    pretty: args.pretty,
    handler: async () => {
      const result = await schemaRuntime({
        flags: {
          full: args.full,
          json: args.json,
        },
      })
      return { data: result.data, meta: result.meta }
    },
  })
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
    const out = await runSchema({
      pretty: flags.pretty,
      full: flags.full,
      json: flags.json,
    })
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    return JSON.parse(out.stdout)
  }
}
