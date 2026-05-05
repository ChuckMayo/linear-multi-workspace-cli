/**
 * Schema runtime — Phase 4 PLAN 04-04, INT-03.
 *
 * Exposes the Linear GraphQL schema in two forms:
 *   - Default: compact SDL (triple-quoted descriptions stripped) for token-budget efficiency
 *   - --full: SDL with descriptions included (opt-in verbose mode)
 *   - --json: Standard introspection JSON (__schema format) via `introspectionFromSchema`
 *
 * Zero network calls — reads the committed vendored `schema.graphql` via
 * `getLinearSchema()` (lazy-cached in schema-loader.ts).
 *
 * Counts included in all modes:
 *   types_count = 1081 (user types, excluding __* introspection builtins)
 *   queries_count = 151
 *   mutations_count = 351
 *   subscriptions_count = 75
 */
import { type GraphQLSchema, introspectionFromSchema, printSchema } from 'graphql'
import { getLinearSchema } from '@/lib/schema-loader.js'

export interface SchemaDataSdl {
  schema: string
  types_count: number
  queries_count: number
  mutations_count: number
  subscriptions_count: number
}

export interface SchemaDataJson {
  schema: { __schema: object }
  types_count: number
  queries_count: number
  mutations_count: number
  subscriptions_count: number
}

export interface SchemaRuntimeArgs {
  flags: {
    full?: boolean
    json?: boolean
    pretty?: boolean
  }
}

export interface SchemaRuntimeResult {
  data: SchemaDataSdl | SchemaDataJson
}

/**
 * Returns type counts from the Linear GraphQL schema.
 * Excludes built-in `__*` introspection types.
 */
function getTypeCounts(schema: GraphQLSchema): {
  types_count: number
  queries_count: number
  mutations_count: number
  subscriptions_count: number
} {
  const typeMap = schema.getTypeMap()
  const userTypes = Object.values(typeMap).filter((t) => !t.name.startsWith('__'))
  return {
    types_count: userTypes.length,
    queries_count: Object.keys(schema.getQueryType()?.getFields() ?? {}).length,
    mutations_count: Object.keys(schema.getMutationType()?.getFields() ?? {}).length,
    subscriptions_count: Object.keys(schema.getSubscriptionType()?.getFields() ?? {}).length,
  }
}

/**
 * Returns the Linear schema as compact SDL (descriptions stripped) or with descriptions,
 * or as standard introspection JSON.
 *
 * This is the named runtime export used by tests and the oclif command shim.
 *
 * Returns `{ data }` only — the command shim wraps the result in the Phase 1
 * envelope via `runCommand`, which sets `meta.command` from the commandPath.
 * No `meta` is returned here on purpose: the runtime owns the data shape and
 * the kernel owns the envelope.
 */
export async function schemaRuntime(args: SchemaRuntimeArgs): Promise<SchemaRuntimeResult> {
  const { flags } = args
  const schema = getLinearSchema()
  const counts = getTypeCounts(schema)

  if (flags.json) {
    const introspectionResult = introspectionFromSchema(schema, {
      descriptions: flags.full ?? false,
      specifiedByUrl: false,
      directiveIsRepeatable: false,
      schemaDescription: false,
    })
    const data: SchemaDataJson = {
      // introspectionResult is an IntrospectionQuery; we expose the __schema object
      schema: introspectionResult as unknown as { __schema: object },
      ...counts,
    }
    return { data }
  }

  // SDL path (default)
  const printed = printSchema(schema)
  // Strip all triple-quoted description blocks (single-line and multi-line).
  // The non-greedy [\s\S]*? handles both forms; \n? handles trailing newlines.
  const sdl = flags.full ? printed : printed.replace(/"""[\s\S]*?"""\n?/g, '')
  const data: SchemaDataSdl = { schema: sdl, ...counts }
  return { data }
}
