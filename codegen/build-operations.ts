/**
 * codegen/build-operations.ts — Phase 3 PLAN 03-01 Task 2.
 *
 * Walks the vendored Linear schema (`schema.graphql`) and emits three
 * deterministic, byte-stable artifacts:
 *
 *   1. <outDir>/_registry.graphql
 *      One default GraphQL operation per Query/Mutation root field
 *      (subscriptions excluded). Default selection is depth-1: all scalars
 *      at the root return type, plus `{ id, name? }` on object/interface
 *      relations, and `nodes { ...scalars + id }` on *Connection types.
 *      Operation names are PascalCase root-field names (Issues, IssueCreate).
 *
 *   2. <outDir>/_registry.zod.ts
 *      One Zod var-schema per operation, keyed by `<OpName>VarsSchema`.
 *      Variable definitions are derived from the root field's args with
 *      strict scalar/enum/input mapping (Pitfall 8 — never `z.any()`).
 *      Recursive input types use `z.lazy(() => ...)` with a Map cache to
 *      avoid re-emitting the same type definition.
 *
 *   3. <generatedDir>/operations.ts
 *      Composes typed documents emitted by `@graphql-codegen/client-preset`
 *      (from artifact #1) with the Zod schemas (artifact #2) into the
 *      OPERATION_REGISTRY lookup table that the `raw` / `raw batch` /
 *      `graphql` runtimes share.
 *
 * Determinism contract (Pitfall 3): every loop sorts inputs by name BEFORE
 * iterating. `parse(source, { noLocation: true })` strips location metadata
 * so `print()` output is canonical. Single trailing `\n` on every file.
 *
 * Exports `buildRegistry(opts)` so determinism tests can drive the builder
 * directly into tmpdirs without shelling out (`test/codegen/build-operations.test.ts`).
 *
 * Refresh path: when `@linear/sdk` is bumped, re-vendor `schema.graphql`
 * via `npm run fetch-schema` then rerun `npm run codegen`. Any new operation
 * surfaces as a snapshot diff in `test/lib/__snapshots__/operation-registry.test.ts.snap`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSchema,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputObjectType,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  print,
} from 'graphql'

// ─── Public surface ─────────────────────────────────────────────────────

export interface BuildRegistryOptions {
  /** Absolute path to the vendored `schema.graphql`. */
  schemaPath: string
  /** Absolute path to the directory that receives `_registry.graphql` + `_registry.zod.ts`. */
  outDir: string
  /** Absolute path to the directory that receives `operations.ts`. Defaults to `<outDir>/../generated`. */
  generatedDir?: string
}

/** Idempotent. Writes _registry.graphql + _registry.zod.ts + operations.ts. */
export function buildRegistry(opts: BuildRegistryOptions): void {
  const { schemaPath, outDir, generatedDir = resolve(outDir, '..', 'generated') } = opts

  const sdl = readFileSync(schemaPath, 'utf8')
  const schema = buildSchema(sdl)

  const queryType = schema.getQueryType()
  const mutationType = schema.getMutationType()
  if (!queryType) throw new Error('schema is missing the Query root type')
  if (!mutationType) throw new Error('schema is missing the Mutation root type')

  // Sort once, walk twice (once for the .graphql output, once for the Zod
  // file) — same sorted lists feed both loops so the two artifacts agree.
  const queryFields = sortByName(Object.values(queryType.getFields())).filter(
    (f) => f.name !== '_dummy',
  )
  const mutationFields = sortByName(Object.values(mutationType.getFields()))

  // Detect Query/Mutation PascalCase collisions (e.g. `initiativeUpdate`
  // exists as both a Query field and a Mutation field — both PascalCase to
  // `InitiativeUpdate`). Mutations in collision get a `Mutation` suffix so
  // every registry key is unique. The 499 non-colliding ops keep their
  // canonical PascalCase names.
  const queryPascalSet = new Set(queryFields.map((f) => pascalCase(f.name)))
  const collidingMutationNames = new Set(
    mutationFields.filter((f) => queryPascalSet.has(pascalCase(f.name))).map((f) => f.name),
  )

  // ─── 1. Build operation source strings ────────────────────────────────
  const opEntries: OperationDescriptor[] = []
  for (const field of queryFields) opEntries.push(buildOperation(schema, field, 'query', false))
  for (const field of mutationFields) {
    opEntries.push(
      buildOperation(schema, field, 'mutation', collidingMutationNames.has(field.name)),
    )
  }

  const sortedEntries = [...opEntries].sort((a, b) => a.opName.localeCompare(b.opName))

  // ─── 2. Emit _registry.graphql ────────────────────────────────────────
  const opBlocks = sortedEntries.map((e) => e.printedSource)
  const registryGraphqlPath = resolve(outDir, '_registry.graphql')
  writeFileSync(registryGraphqlPath, `${opBlocks.join('\n')}`, 'utf8')

  // ─── 3. Emit _registry.zod.ts ─────────────────────────────────────────
  const zodOutput = emitZodFile(schema, sortedEntries)
  const registryZodPath = resolve(outDir, '_registry.zod.ts')
  writeFileSync(registryZodPath, zodOutput, 'utf8')

  // ─── 4. Emit src/generated/operations.ts ──────────────────────────────
  const opsOutput = emitRegistryComposition(sortedEntries)
  const opsPath = resolve(generatedDir, 'operations.ts')
  writeFileSync(opsPath, opsOutput, 'utf8')
}

// ─── Module-level helpers ───────────────────────────────────────────────

interface OperationDescriptor {
  /** PascalCase operation name (`Issues`, `IssueCreate`). */
  opName: string
  /** GraphQL root-field name (`issues`, `issueCreate`). */
  fieldName: string
  /** Operation kind discriminator. */
  kind: 'query' | 'mutation'
  /** Canonical pre-printed source string with single trailing `\n`. */
  printedSource: string
  /** Field args used to derive the Zod var schema. */
  args: readonly GraphQLArgument[]
}

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Convert a GraphQL root-field name to the PascalCase identifier that
 * `@graphql-codegen/client-preset` uses for the corresponding `<Name>Document`
 * export. Matches `change-case`'s `pascalCase` semantics so this builder's
 * imports line up with what graphql-codegen actually emits.
 *
 * Examples:
 *   issues               -> Issues
 *   issueCreate          -> IssueCreate
 *   attachmentLinkURL    -> AttachmentLinkUrl   (URL run collapses)
 *   attachmentLinkGitHubPR -> AttachmentLinkGitHubPr
 *   issueImportCheckCSV  -> IssueImportCheckCsv
 *
 * Algorithm: split on word boundaries (lowercase->uppercase, uppercase run
 * followed by lowercase, digit boundaries), lowercase each word, then
 * capitalize the first letter of each word.
 */
function pascalCase(s: string): string {
  if (s.length === 0) return s
  // Split into "words" using two boundary rules:
  //   1. Insert space between a lowercase/digit and an uppercase letter
  //      ("issueCreate" -> "issue Create")
  //   2. Insert space between two uppercase letters when the second is
  //      followed by a lowercase letter ("URLPath" -> "URL Path")
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
}

// ─── GraphQL operation source emission ──────────────────────────────────

function buildOperation(
  schema: GraphQLSchema,
  field: GraphQLField<unknown, unknown>,
  kind: 'query' | 'mutation',
  /**
   * If true, suffix the operation name with `Mutation` to disambiguate
   * from a same-named Query root field (e.g. `initiativeUpdate` exists as
   * both Query and Mutation; the Mutation becomes `InitiativeUpdateMutation`).
   * Plan 03-01 deviation logged in SUMMARY.
   */
  disambiguate: boolean,
): OperationDescriptor {
  const baseName = pascalCase(field.name)
  const opName = disambiguate ? `${baseName}Mutation` : baseName
  const sortedArgs = sortByName(field.args)

  // Variable definitions: `$name: Type` (preserve nullability via toString()).
  const varDefs = sortedArgs.map((a) => `$${a.name}: ${a.type.toString()}`)
  // Field call args: `name: $name`. Same sort order so output stays stable.
  const callArgs = sortedArgs.map((a) => `${a.name}: $${a.name}`)

  const selection = emitDepth1Selection(schema, field.type)

  // Compose source with consistent indentation/whitespace, then re-print
  // through graphql.print(parse(...)) so we get canonical formatting that
  // matches what the validator/codegen will see.
  const variablesBlock = varDefs.length > 0 ? `(${varDefs.join(', ')})` : ''
  const callArgsBlock = callArgs.length > 0 ? `(${callArgs.join(', ')})` : ''

  const raw = `${kind} ${opName}${variablesBlock} {
  ${field.name}${callArgsBlock}${selection ? ` ${selection}` : ''}
}`

  // Canonicalize via parse + print (noLocation strips file positions).
  const ast = parse(raw, { noLocation: true })
  const printedSource = `${print(ast)}\n`

  return { opName, fieldName: field.name, kind, printedSource, args: sortedArgs }
}

/**
 * Emit a depth-1 selection set for a GraphQL output type.
 *
 * Rules (per CONTEXT § Decisions line 38 + RESEARCH § Pattern 1):
 *   - Strip NonNull / List wrappers
 *   - Scalar / Enum: no selection set required (caller emits empty)
 *   - Object: { ...scalars-and-enums + relation { id, name? } + connection { nodes { ... } } }
 *   - Interface / Union: { __typename + ...on Concrete { id } per concrete impl }
 *   - *Connection: { nodes { depth-1 of node type } } — no edges, no pageInfo
 *
 * Returns either an empty string (scalar leaf) or `"{ ... }"` (selection set
 * with surrounding braces).
 */
function emitDepth1Selection(schema: GraphQLSchema, type: GraphQLOutputType): string {
  const named = unwrapNamedType(type)

  if (isScalarType(named) || isEnumType(named)) {
    // Scalar/Enum return — no selection allowed in GraphQL syntax.
    return ''
  }

  if (isUnionType(named)) {
    const concrete = sortByName(schema.getPossibleTypes(named))
    // Each concrete type must actually expose an `id` field; not every union
    // member does (e.g. payload union members). Skip those — emit only
    // __typename when no concrete has id.
    const fragments = concrete
      .filter((t) => 'id' in t.getFields())
      .map((t) => `... on ${t.name} { id }`)
    return fragments.length > 0 ? `{ __typename ${fragments.join(' ')} }` : `{ __typename }`
  }

  if (isInterfaceType(named)) {
    const concrete = sortByName(schema.getPossibleTypes(named))
    const fragments = concrete
      .filter((t) => 'id' in t.getFields())
      .map((t) => `... on ${t.name} { id }`)
    // Surface __typename so agents know which concrete type they got.
    return fragments.length > 0 ? `{ __typename ${fragments.join(' ')} }` : `{ __typename }`
  }

  if (isObjectType(named)) {
    // *Connection special case: emit `nodes { ...selection of node type }`
    // and skip edges + pageInfo per CONTEXT default.
    if (isConnectionType(named)) {
      const nodesField = named.getFields().nodes
      if (!nodesField) {
        // Defensive: a connection without `nodes` shouldn't happen on Linear's
        // schema, but if it does, fall back to __typename.
        return `{ __typename }`
      }
      const innerSelection = emitDepth1Selection(schema, nodesField.type)
      return innerSelection ? `{ nodes ${innerSelection} }` : '{ nodes { __typename } }'
    }

    // Regular object: scalar/enum fields + minimal relation projections.
    const fields = sortByName(Object.values(named.getFields()))
    const parts: string[] = []
    for (const f of fields) {
      // Skip fields that take required args we can't supply (these would
      // need explicit variables and break the depth-1 default).
      const hasRequiredArg = f.args.some((a) => isNonNullType(a.type))
      if (hasRequiredArg) continue

      const fNamed = unwrapNamedType(f.type)
      if (isScalarType(fNamed) || isEnumType(fNamed)) {
        parts.push(f.name)
        continue
      }

      if (isUnionType(fNamed) || isInterfaceType(fNamed)) {
        // For nested union/interface fields at depth 1, just take id via
        // __typename + concrete fragments — but cap recursion: if any
        // concrete has no `id` field, skip rather than emit invalid SDL.
        const concrete = sortByName(schema.getPossibleTypes(fNamed))
        const concreteWithId = concrete.filter((c) => 'id' in c.getFields())
        if (concreteWithId.length === 0) continue
        const frags = concreteWithId.map((c) => `... on ${c.name} { id }`).join(' ')
        parts.push(`${f.name} { __typename ${frags} }`)
        continue
      }

      if (isObjectType(fNamed)) {
        if (isConnectionType(fNamed)) {
          // Skip nested connections at depth 1 — agents pull them via
          // `--include` (Phase 3 plan 03-04) or free-form `graphql`.
          continue
        }
        // Object relation: minimal { id, name? } projection.
        const subFields = fNamed.getFields()
        const sel: string[] = []
        if ('id' in subFields) sel.push('id')
        if ('name' in subFields) sel.push('name')
        if (sel.length === 0) continue
        parts.push(`${f.name} { ${sel.join(' ')} }`)
      }

      // Fall-through (input objects can't appear in output positions; lists
      // are unwrapped at the top of the function). Skip silently.
    }

    if (parts.length === 0) return '{ __typename }'
    return `{ ${parts.join(' ')} }`
  }

  // Fallthrough — should be unreachable for valid output types.
  return '{ __typename }'
}

function isConnectionType(t: GraphQLNamedType): boolean {
  return isObjectType(t) && t.name.endsWith('Connection')
}

function unwrapNamedType(type: GraphQLType): GraphQLNamedType {
  let cur: GraphQLType = type
  while (isNonNullType(cur) || isListType(cur)) {
    cur = cur.ofType
  }
  return cur as GraphQLNamedType
}

// ─── Zod schema emission ────────────────────────────────────────────────

/**
 * Custom GraphQL scalar → Zod expression mapping. Mirrors
 * `linear-multi-workspace/codegen.ts:scalars`.
 */
const SCALAR_TO_ZOD: Record<string, string> = {
  String: 'z.string()',
  Int: 'z.number().int()',
  Float: 'z.number()',
  Boolean: 'z.boolean()',
  ID: 'z.string()',
  UUID: 'z.string()',
  DateTime: 'z.string()',
  DateTimeOrDuration: 'z.string()',
  Duration: 'z.string()',
  TimelessDate: 'z.string()',
  TimelessDateOrDuration: 'z.string()',
  JSON: 'z.unknown()',
  JSONObject: 'z.record(z.string(), z.unknown())',
  IssueAssignedToYouNotificationType: 'z.string()',
  IssueCommentMentionNotificationType: 'z.string()',
  IssueCommentReactionNotificationType: 'z.string()',
  IssueEmojiReactionNotificationType: 'z.string()',
  IssueMentionNotificationType: 'z.string()',
  IssueNewCommentNotificationType: 'z.string()',
  IssueStatusChangedNotificationType: 'z.string()',
  IssueUnassignedFromYouNotificationType: 'z.string()',
}

interface ZodEmitContext {
  /** Names of input objects already emitted (to avoid duplicates). */
  emittedInputs: Set<string>
  /** Names of input objects currently in-flight (for recursion detection via z.lazy). */
  inFlight: Set<string>
  /** Names of input objects we know exist and need top-level emission. */
  needed: Set<string>
  /** Map of input/enum name -> emitted Zod source (for top-of-file deduplication). */
  emittedDefinitions: Map<string, string>
  /** Names of enums already emitted. */
  emittedEnums: Set<string>
}

function emitZodFile(schema: GraphQLSchema, ops: readonly OperationDescriptor[]): string {
  const ctx: ZodEmitContext = {
    emittedInputs: new Set(),
    inFlight: new Set(),
    needed: new Set(),
    emittedDefinitions: new Map(),
    emittedEnums: new Set(),
  }

  const opSchemaLines: string[] = []
  for (const op of ops) {
    // Emit top-level vars schema for this op.
    const fields = op.args.map((arg) => {
      const zodExpr = zodForInputType(schema, arg.type, ctx)
      // Optional vs required: NonNull → required key, nullable → optional.
      const optional = !isNonNullType(arg.type)
      const value = optional ? `${zodExpr}.optional()` : zodExpr
      return `  ${JSON.stringify(arg.name)}: ${value},`
    })

    if (fields.length === 0) {
      opSchemaLines.push(`export const ${op.opName}VarsSchema = z.object({}).strict()`)
    } else {
      opSchemaLines.push(
        `export const ${op.opName}VarsSchema = z.object({\n${fields.join('\n')}\n}).strict()`,
      )
    }
  }

  // Emit input/enum definitions in name-sorted order at top of file (above
  // op schemas). Use z.lazy where needed to break recursion cycles.
  const definitionNames = [...ctx.emittedDefinitions.keys()].sort()
  const defLines = definitionNames.map((name) => ctx.emittedDefinitions.get(name) as string)

  const header = `/**
 * src/operations/_registry.zod.ts — AUTO-GENERATED by codegen/build-operations.ts
 *
 * Phase 3 PLAN 03-01. DO NOT EDIT BY HAND. Run \`npm run codegen\` to refresh.
 *
 * Exports one \`<OpName>VarsSchema\` per operation in OPERATION_REGISTRY.
 * The \`raw\` runtime parses \`--vars\` JSON and validates it against the
 * matching schema before dispatching to \`linearClient.client.rawRequest\`.
 *
 * Generated input-object and enum schemas are hoisted to the top of the
 * file so the operation schemas can reference them. Recursive input types
 * (\`IssueFilter\`, etc.) use \`z.lazy(() => ...)\` to break the cycle.
 */

/* biome-disable */
/* eslint-disable */
import { z } from 'zod'

`

  return `${header}${defLines.join('\n\n')}${defLines.length > 0 ? '\n\n' : ''}${opSchemaLines.join('\n\n')}\n`
}

/**
 * Build a Zod source-string expression for a GraphQL input type.
 *
 * Lists and NonNull wrappers are unwrapped here; the caller decides whether
 * to apply `.optional()` based on the outermost NonNull-ness.
 */
function zodForInputType(
  schema: GraphQLSchema,
  type: GraphQLInputType,
  ctx: ZodEmitContext,
): string {
  if (isNonNullType(type)) {
    return zodForInputType(schema, type.ofType as GraphQLInputType, ctx)
  }
  if (isListType(type)) {
    const inner = type.ofType as GraphQLInputType
    const innerExpr = zodForInputType(schema, inner, ctx)
    // Inner nullability matters: [Int!] → array of required ints; [Int] →
    // array of nullable ints (Zod doesn't have nullable-element ergonomics
    // beyond `.nullable()`; we apply it when the inner is non-NonNull).
    const innerWithOpt = isNonNullType(inner) ? innerExpr : `${innerExpr}.nullable()`
    return `z.array(${innerWithOpt})`
  }

  const named = type as GraphQLNamedType
  if (isScalarType(named)) {
    const mapped = SCALAR_TO_ZOD[named.name]
    if (!mapped) {
      throw new Error(
        `codegen/build-operations.ts: unmapped GraphQL scalar "${named.name}". ` +
          `Add it to SCALAR_TO_ZOD (and to codegen.ts:scalars) before continuing.`,
      )
    }
    return mapped
  }

  if (isEnumType(named)) {
    if (!ctx.emittedEnums.has(named.name)) {
      ctx.emittedEnums.add(named.name)
      const values = sortByName(named.getValues()).map((v) => JSON.stringify(v.name))
      const literal = values.length > 0 ? `z.enum([${values.join(', ')}])` : 'z.never()' // empty enum — Linear doesn't ship any, but be safe.
      ctx.emittedDefinitions.set(named.name, `const ${zodEnumName(named.name)} = ${literal}`)
    }
    return zodEnumName(named.name)
  }

  if (isInputObjectType(named)) {
    return zodForInputObject(schema, named, ctx)
  }

  // Output types should never appear here; fail loud.
  throw new Error(
    `codegen/build-operations.ts: unexpected GraphQL type ${named.name} in input position`,
  )
}

function zodEnumName(name: string): string {
  return `${name}Enum`
}

function zodInputObjectName(name: string): string {
  return `${name}InputSchema`
}

function zodForInputObject(
  schema: GraphQLSchema,
  type: GraphQLInputObjectType,
  ctx: ZodEmitContext,
): string {
  const symbol = zodInputObjectName(type.name)

  // Already emitted at top of file → just refer by name.
  if (ctx.emittedInputs.has(type.name)) return symbol

  // Currently being emitted higher up the call stack → recursion. Refer
  // by name (the top-level definition uses z.lazy under the hood so this
  // works without further plumbing).
  if (ctx.inFlight.has(type.name)) return symbol

  ctx.inFlight.add(type.name)

  const fields = sortByName(Object.values(type.getFields()))
  const fieldLines = fields.map((f) => emitInputFieldLine(schema, f, ctx))

  ctx.inFlight.delete(type.name)
  ctx.emittedInputs.add(type.name)

  // Wrap the body in z.lazy so forward references resolve correctly. This
  // is universally safe (z.lazy adds negligible overhead) and removes the
  // need to topologically sort definitions.
  const body = fieldLines.length > 0 ? `z.object({\n${fieldLines.join('\n')}\n})` : 'z.object({})'
  ctx.emittedDefinitions.set(
    type.name,
    `const ${symbol}: z.ZodType<unknown> = z.lazy(() => ${body})`,
  )

  return symbol
}

function emitInputFieldLine(
  schema: GraphQLSchema,
  field: GraphQLInputField,
  ctx: ZodEmitContext,
): string {
  const expr = zodForInputType(schema, field.type, ctx)
  const optional = !isNonNullType(field.type)
  const value = optional ? `${expr}.optional()` : expr
  return `  ${JSON.stringify(field.name)}: ${value},`
}

// ─── Registry composition emission ──────────────────────────────────────

function emitRegistryComposition(ops: readonly OperationDescriptor[]): string {
  // Each entry imports `<OpName>Document` from ./graphql.js and
  // `<OpName>VarsSchema` from ../operations/_registry.zod.js.
  const docImports = ops.map((o) => `${o.opName}Document`).join(',\n  ')
  const zodImports = ops.map((o) => `${o.opName}VarsSchema`).join(',\n  ')

  // Body: one entry per op with a string-literal pre-printed source so
  // there is NO runtime print() cost (Pitfall 4).
  //
  // The `document` cast widens the TypedDocumentNode<TResult, TVars> emitted
  // by client-preset to TypedDocumentNode<unknown, unknown> so the
  // OPERATION_REGISTRY satisfies the Record<string, OperationEntry>
  // constraint. The runtime uses `entry.source` (a string) for dispatch via
  // client.client.rawRequest — it never inspects the document's type
  // parameters — so this cast is safe and only affects type inference at
  // the registry boundary (callers that want fine-grained types reach into
  // the underlying generated types directly).
  const entries = ops.map((o) => {
    const sourceLiteral = JSON.stringify(o.printedSource)
    return `  ${o.opName}: {
    kind: '${o.kind}' as const,
    document: ${o.opName}Document as TypedDocumentNode<unknown, unknown>,
    source: ${sourceLiteral},
    varsSchema: ${o.opName}VarsSchema as z.ZodType<unknown>,
  },`
  })

  return `/**
 * src/generated/operations.ts — AUTO-GENERATED by codegen/build-operations.ts
 *
 * Phase 3 PLAN 03-01. DO NOT EDIT BY HAND. Run \`npm run codegen\` to refresh.
 *
 * Composes:
 *   - TypedDocumentNode constants emitted by @graphql-codegen/client-preset
 *     from src/operations/_registry.graphql
 *   - Zod variable schemas emitted by codegen/build-operations.ts into
 *     src/operations/_registry.zod.ts
 *
 * Source strings are pre-printed at codegen time so the runtime never pays
 * print() cost (RESEARCH Pitfall 4 — keeps cold-start budget happy).
 */

/* eslint-disable */
import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import type { z } from 'zod'
import {
  ${docImports},
} from './graphql.js'
import {
  ${zodImports},
} from '../operations/_registry.zod.js'

export type OperationKind = 'query' | 'mutation'

export interface OperationEntry<TResult = unknown, TVars = unknown> {
  kind: OperationKind
  /** TypedDocumentNode emitted by client-preset — kept for Phase 4 introspection. */
  document: TypedDocumentNode<TResult, TVars>
  /** Pre-printed canonical GraphQL source string handed to client.client.rawRequest. */
  source: string
  /** Zod schema validating --vars JSON before SDK dispatch. */
  varsSchema: z.ZodType<TVars>
}

export const OPERATION_REGISTRY = {
${entries.join('\n')}
} as const satisfies Record<string, OperationEntry>

export type OperationName = keyof typeof OPERATION_REGISTRY
`
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

/** Convenience entrypoint used by `npm run build-operations`. */
export function main(): void {
  buildRegistry({
    schemaPath: resolve(repoRoot, 'schema.graphql'),
    outDir: resolve(repoRoot, 'src/operations'),
    generatedDir: resolve(repoRoot, 'src/generated'),
  })
  process.stdout.write(
    `build-operations: wrote registry artifacts to src/operations and src/generated\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
