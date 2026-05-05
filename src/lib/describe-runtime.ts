/**
 * `describeRuntime` — Phase 4 PLAN 04-03, INT-02.
 *
 * Returns input JSON Schema (from Zod) + examples for curated commands,
 * or input JSON Schema + SDL fragment for raw operations. Zero network calls.
 *
 * Disambiguation algorithm (CONTEXT.md § Specifics, RESEARCH § Pitfall 6):
 *   - target.includes(' ') || /^[a-z]/.test(target) → curated path
 *   - PascalCase single token (uppercase start, no spaces) → raw path
 *   - Not found → DESCRIBE_COMMAND_NOT_FOUND with Levenshtein suggestions
 *
 * Exports:
 *   - `describeRuntime` — named runtime function (test seam)
 *   - `describeRuntime` is the only export; command shim lives in src/commands/describe.ts
 */

import { getNamedType, isInterfaceType, isObjectType, isUnionType, printType } from 'graphql'
import { z } from 'zod'
import { LinearAgentError } from '@/core/errors/error.js'
import { OPERATION_REGISTRY, type OperationName } from '@/generated/operations.js'
import { CURATED_REGISTRY } from '@/lib/introspection-registry.js'
import { suggestClosest } from '@/lib/levenshtein.js'
import { getLinearSchema } from '@/lib/schema-loader.js'

/**
 * The Phase 1 envelope output schema for curated commands.
 *
 * Mirrors the real envelope contract from `src/core/output/envelope.ts`:
 *   - SuccessEnvelope: { $apiVersion, ok: true, data, meta: Meta }
 *   - FailureEnvelope: { $apiVersion, ok: false, error, meta: FailureMeta }
 *
 * Per CONTEXT.md § describe shape — v1 leaves `data: z.unknown()`.
 * Per-entity output schemas deferred to Phase 5/6.
 *
 * If you change the envelope shape in `src/core/output/envelope.ts`, the
 * snapshot tests in `test/lib/describe-runtime.test.ts` and
 * `test/commands/describe.test.ts` will fail until this schema is brought
 * back into parity — that's intentional.
 */
const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
  hasPreviousPage: z.boolean(),
  startCursor: z.string().nullable(),
})

const ComplexitySchema = z.object({
  cost: z.number(),
  remaining: z.number(),
})

const BatchSchema = z.object({
  count: z.number(),
  kinds: z.object({
    query: z.number(),
    mutation: z.number(),
  }),
})

const WorkspaceSourceSchema = z.enum(['flag', 'env', 'active', 'single', 'api-key-env'])

const MetaSchema = z.object({
  command: z.string(),
  workspace: z.string().nullable().optional(),
  workspaceSource: WorkspaceSourceSchema.optional(),
  pageInfo: PageInfoSchema.optional(),
  complexity: ComplexitySchema.optional(),
  totalCount: z.number().optional(),
  batch: BatchSchema.optional(),
})

const FailureMetaSchema = z.object({
  command: z.string(),
  workspace: z.string().nullable().optional(),
  workspaceSource: WorkspaceSourceSchema.optional(),
})

const SuccessEnvelopeSchema = z.object({
  $apiVersion: z.literal('1'),
  ok: z.literal(true),
  data: z.unknown(),
  meta: MetaSchema,
})

const FailureEnvelopeSchema = z.object({
  $apiVersion: z.literal('1'),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    transient: z.boolean(),
    retryAfterMs: z.number().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  meta: FailureMetaSchema,
})

const EnvelopeOutputSchema = z.union([SuccessEnvelopeSchema, FailureEnvelopeSchema])

/**
 * Standard z.toJSONSchema() options per CONTEXT.md § stack contract.
 * Always use draft-2020-12 + unrepresentable:'any' to avoid crashes on
 * z.transform() or z.unknown() fields in raw varsSchemas (RESEARCH Pitfall 1, 4).
 */
const JSON_SCHEMA_OPTS = {
  target: 'draft-2020-12',
  unrepresentable: 'any',
} as const

/**
 * Convert PascalCase operation name to camelCase for root-type field lookup.
 * e.g. 'IssueCreate' → 'issueCreate'
 */
function toCamelCase(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Get a compact SDL fragment for the return type of a raw operation.
 * Falls back to a comment string if resolution fails (acceptable for v1).
 */
function getSdlFragment(operationName: string, kind: 'query' | 'mutation'): string {
  try {
    const schema = getLinearSchema()
    const rootType = kind === 'query' ? schema.getQueryType() : schema.getMutationType()
    const fieldName = toCamelCase(operationName)
    const field = rootType?.getFields()[fieldName]
    const returnType = field ? getNamedType(field.type) : undefined
    if (
      returnType &&
      (isObjectType(returnType) || isInterfaceType(returnType) || isUnionType(returnType))
    ) {
      return printType(returnType)
    }
    return `# Return type: ${returnType?.name ?? 'unknown'}\n# Use the 'schema' command for full type definitions.`
  } catch {
    return `# Return type resolution unavailable. Use the 'schema' command for full definitions.`
  }
}

export interface DescribeRuntimeArgs {
  args: { command: string }
  flags: Record<string, unknown>
}

export interface DescribeCuratedData {
  command: string
  kind: 'curated'
  input: Record<string, unknown>
  output: Record<string, unknown>
  examples: Array<{ name: string; args: string; output: Record<string, unknown> }>
}

export interface DescribeRawData {
  command: string
  kind: 'raw'
  input: Record<string, unknown>
  output: string
  examples: []
}

export interface DescribeResult {
  data: DescribeCuratedData | DescribeRawData
}

/**
 * Core runtime for `linear-agent describe <command>`.
 *
 * @throws {LinearAgentError} with code DESCRIBE_COMMAND_NOT_FOUND when target is not found
 */
export async function describeRuntime(args: DescribeRuntimeArgs): Promise<DescribeResult> {
  const target = args.args.command

  // Disambiguation: lowercase start or contains space → curated
  const likelyCurated = target.includes(' ') || /^[a-z]/.test(target)

  if (likelyCurated) {
    const entry = CURATED_REGISTRY.find((e) => e.id === target)
    if (entry) {
      // Curated path: convert inputSchema + EnvelopeOutputSchema to JSON Schema
      const inputJsonSchema = z.toJSONSchema(entry.inputSchema, JSON_SCHEMA_OPTS) as Record<
        string,
        unknown
      >
      const outputJsonSchema = z.toJSONSchema(EnvelopeOutputSchema, JSON_SCHEMA_OPTS) as Record<
        string,
        unknown
      >
      return {
        data: {
          command: target,
          kind: 'curated',
          input: inputJsonSchema,
          output: outputJsonSchema,
          examples: entry.examples,
        },
      }
    }
    // Not found in curated → fall through to not-found error
  } else {
    // Raw path: PascalCase single token. Guard with `Object.hasOwn` rather
    // than relying on the `/^[a-z]/.test(target)` disambiguation alone — a
    // stray prototype-chain hit would otherwise sneak through as a "found"
    // entry and crash later on `entry.varsSchema`.
    const entry = Object.hasOwn(OPERATION_REGISTRY, target)
      ? OPERATION_REGISTRY[target as OperationName]
      : undefined
    if (entry) {
      const inputJsonSchema = z.toJSONSchema(entry.varsSchema, JSON_SCHEMA_OPTS) as Record<
        string,
        unknown
      >
      const outputFragment = getSdlFragment(target, entry.kind)
      return {
        data: {
          command: target,
          kind: 'raw',
          input: inputJsonSchema,
          output: outputFragment,
          examples: [],
        },
      }
    }
    // Not found in raw → fall through to not-found error
  }

  // Not found in either registry — build suggestions from both
  const allNames = [...CURATED_REGISTRY.map((e) => e.id), ...Object.keys(OPERATION_REGISTRY)]
  const suggestions = suggestClosest(target, allNames, 3)

  throw new LinearAgentError({
    code: 'DESCRIBE_COMMAND_NOT_FOUND',
    message: `unknown command: '${target}'. Did you mean: ${suggestions.join(', ')}?`,
    details: { target, suggestions },
  })
}
