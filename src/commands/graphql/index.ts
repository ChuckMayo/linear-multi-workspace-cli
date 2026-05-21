/**
 * `linear-agent graphql` — free-form GraphQL escape hatch for Phase 3 RAW-03.
 *
 * Execute any GraphQL query/mutation against the Linear API. The query is
 * locally validated against the vendored schema before dispatch — syntax
 * errors and unknown fields are caught WITHOUT spending a Linear API call.
 *
 * Canonical agent surface: `--query=@file.graphql` (file reference).
 * Inline form: `--query='{ viewer { id } }'` also supported for ergonomics.
 *
 * This file exports BOTH:
 *   - `export default class GraphqlCommand` — the oclif Command class
 *   - `export { runGraphql }` — named re-export for test seam (tests call
 *     the runtime directly without spawning a subprocess)
 */
import { Command, Flags } from '@oclif/core'
import { runGraphql as graphqlRuntime } from '@/lib/graphql-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export type { RunGraphqlFlags, RunGraphqlInput, RunGraphqlOutput } from '@/lib/graphql-runtime.js'
// Re-export runGraphql so tests can call it directly.
export { runGraphql } from '@/lib/graphql-runtime.js'

export default class GraphqlCommand extends Command {
  static override enableJsonFlag = true
  static override description =
    'Execute a free-form GraphQL query against Linear (locally validated against vendored schema before dispatch).'
  static override examples = [
    '<%= config.bin %> graphql --query=@./query.graphql --vars \'{"id": "..."}\'',
    "<%= config.bin %> graphql --query='{ viewer { id name } }'",
    '<%= config.bin %> graphql --query=@./mutation.graphql --allow-mutations --workspace acme',
  ]
  static override flags = {
    ...BASE_FLAGS,
    workspace: Flags.string({
      description: 'Workspace name (overrides active default and LINEAR_WORKSPACE)',
    }),
    'allow-active-workspace-write': Flags.boolean({
      default: false,
      description:
        'Per-invocation opt-in to use the active default workspace for mutation operations (WSP-06)',
    }),
    'allow-mutations': Flags.boolean({
      default: false,
      description:
        'Required flag to execute mutation operations. Prevents accidental data modification.',
    }),
    query: Flags.string({
      required: true,
      description:
        'GraphQL query source: inline string (e.g. "{ viewer { id } }") OR file reference (@./query.graphql)',
    }),
    vars: Flags.string({
      description:
        'Variables as inline JSON (e.g. \'{"id": "..."}\') OR file reference (@./vars.json)',
    }),
  }

  async run(): Promise<unknown> {
    const { flags } = await this.parse(GraphqlCommand)
    const callArgs: GraphqlCommandArgs = {
      query: flags.query,
      pretty: flags.pretty,
    }
    if (flags.workspace !== undefined) callArgs.workspace = flags.workspace
    if (flags['allow-active-workspace-write'] !== undefined)
      callArgs.allowActiveWorkspaceWrite = flags['allow-active-workspace-write']
    if (flags['allow-mutations'] !== undefined) callArgs.allowMutations = flags['allow-mutations']
    if (flags.vars !== undefined) callArgs.vars = flags.vars
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runGraphqlCommand(callArgs)
    if (!flags.json) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) process.exitCode = out.exitCode
    return JSON.parse(out.stdout)
  }
}

interface GraphqlCommandArgs {
  query: string
  workspace?: string
  allowActiveWorkspaceWrite?: boolean
  allowMutations?: boolean
  vars?: string
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. */
  retry?: number
}

async function runGraphqlCommand(args: GraphqlCommandArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'graphql',
    pretty: args.pretty,
    handler: async (retryOpts) => {
      const runtimeFlags: Parameters<typeof graphqlRuntime>[0]['flags'] = {
        query: args.query,
      }
      if (args.workspace !== undefined) runtimeFlags.workspace = args.workspace
      if (args.allowActiveWorkspaceWrite !== undefined) {
        runtimeFlags['allow-active-workspace-write'] = args.allowActiveWorkspaceWrite
      }
      if (args.allowMutations !== undefined) {
        runtimeFlags['allow-mutations'] = args.allowMutations
      }
      if (args.vars !== undefined) runtimeFlags.vars = args.vars

      const result = await graphqlRuntime({
        flags: runtimeFlags,
        env: process.env,
        // MNT-03: forward the operator's --retry N (and the --quiet-gated
        // onRetry writer) into the transport wrapper at the dispatch site.
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
