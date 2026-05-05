/**
 * `graphql-runtime` — 8-step pipeline for the free-form GraphQL command.
 *
 * Phase 3 PLAN 03-03, RAW-03.
 *
 * Pipeline:
 *   1. resolveWorkspace (same precedence chain as all commands)
 *   2. Load query text: `--query='...'` (inline) OR `--query=@file.graphql` (file ref)
 *      ENOENT/EACCES → GRAPHQL_QUERY_FILE_NOT_FOUND
 *   3. parse(queryText) — try/catch; syntax errors → GRAPHQL_VALIDATION_FAILED (kind=parse)
 *   4. validate(getLinearSchema(), document) — non-empty → GRAPHQL_VALIDATION_FAILED (kind=validate)
 *      Runs against vendored schema BEFORE any Linear API call (saves quota, gives precise errors)
 *   5. Detect operation kind via .find(d => d.kind === 'OperationDefinition')
 *      Pitfall 5: NOT definitions[0] — first def could be a FragmentDefinition
 *      'subscription' → OPERATION_SUBSCRIPTIONS_UNSUPPORTED (exit 2)
 *   6. If 'mutation': WSP-06 FIRST (requireExplicitWorkspaceForWrite), THEN --allow-mutations check
 *      Order matters — missing workspace is the more dangerous mistake
 *   7. Load vars: inline JSON OR @file.json (file ref takes precedence)
 *   8. Dispatch via client.client.rawRequest wrapped in withFetchInterception + withRateLimitRetry
 *
 * Error codes introduced by this plan:
 *   - GRAPHQL_QUERY_FILE_NOT_FOUND (exit 2) — @file.graphql missing
 *   - GRAPHQL_VALIDATION_FAILED (exit 12) — parse or validate failure
 *   - OPERATION_SUBSCRIPTIONS_UNSUPPORTED (exit 2) — subscription op rejected
 *
 * Codes reused from prior plans (no new snapshots needed):
 *   - RAW_MUTATION_REQUIRES_FLAG (exit 2) — from 03-02
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) — from Phase 1 WSP-06
 *   - LINEAR_API_ERROR (exit 13) — from Phase 1
 */
import { readFile } from 'node:fs/promises'
import type { DocumentNode } from 'graphql'
import { parse, validate } from 'graphql'
import { createLinearClient } from '@/core/client/factory.js'
import type { Config } from '@/core/config/index.js'
import { loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { redact } from '@/core/redact/index.js'
import {
  getLastComplexity,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { resolveWorkspace } from '@/core/workspace/resolver.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { getLinearSchema } from './schema-loader.js'

export interface RunGraphqlFlags {
  workspace?: string
  'allow-active-workspace-write'?: boolean
  'allow-mutations'?: boolean
  query: string // REQUIRED — inline source OR @file.graphql path
  vars?: string // inline JSON OR @file.json
  pretty?: boolean
}

export interface RunGraphqlInput {
  flags: RunGraphqlFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  /** Test seam: override the LinearClient's rawRequest method for unit testing. */
  mockRawRequest?: (query: string, vars: Record<string, unknown>) => Promise<unknown>
}

export interface RunGraphqlOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

export async function runGraphql(input: RunGraphqlInput): Promise<RunGraphqlOutput> {
  const config = (input.loadConfigOverride ?? loadConfig)()

  // Step 1: resolveWorkspace
  const envForResolver: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string } = {}
  if (input.env.LINEAR_WORKSPACE !== undefined) {
    envForResolver.LINEAR_WORKSPACE = input.env.LINEAR_WORKSPACE
  }
  if (input.env.LINEAR_API_KEY !== undefined) {
    envForResolver.LINEAR_API_KEY = input.env.LINEAR_API_KEY
  }
  const resolveFlags = input.flags.workspace ? { workspace: input.flags.workspace } : {}
  const resolved = resolveWorkspace({
    flags: resolveFlags,
    env: envForResolver,
    config,
  })

  // Step 2: Load query text
  const queryText = await loadQueryText(input.flags.query)

  // Step 3: parse (syntax errors → GRAPHQL_VALIDATION_FAILED kind=parse)
  let document: DocumentNode
  try {
    document = parse(queryText)
  } catch (err) {
    throw new LinearAgentError({
      code: 'GRAPHQL_VALIDATION_FAILED',
      message: `query parse failed: ${(err as Error).message}`,
      details: { kind: 'parse', cause: (err as Error).message },
    })
  }

  // Step 4: validate against vendored schema (BEFORE any network call)
  const schema = getLinearSchema()
  const validationErrors = validate(schema, document)
  if (validationErrors.length > 0) {
    throw new LinearAgentError({
      code: 'GRAPHQL_VALIDATION_FAILED',
      message: `query failed schema validation (${validationErrors.length} error${validationErrors.length === 1 ? '' : 's'})`,
      details: {
        kind: 'validate',
        errors: validationErrors.map((e) => ({
          message: e.message,
          locations: e.locations,
          path: e.path,
        })),
      },
    })
  }

  // Step 5: detect operation kind
  // Pitfall 5: use .find(d => d.kind === 'OperationDefinition'), NOT definitions[0]
  // which could be a FragmentDefinition in fragment-first queries.
  const opDef = document.definitions.find((d) => d.kind === 'OperationDefinition')
  if (!opDef || opDef.kind !== 'OperationDefinition') {
    throw new LinearAgentError({
      code: 'GRAPHQL_VALIDATION_FAILED',
      message: 'query has no operation definition',
      details: { kind: 'no-operation' },
    })
  }
  if (opDef.operation === 'subscription') {
    throw new LinearAgentError({
      code: 'OPERATION_SUBSCRIPTIONS_UNSUPPORTED',
      message: 'subscriptions are not supported in v1 — use query or mutation operations',
    })
  }

  // Step 6: WSP-06 + --allow-mutations (mutation only, in that order)
  // WSP-06 FIRST: missing workspace is the more dangerous mistake than missing --allow-mutations
  if (opDef.operation === 'mutation') {
    requireExplicitWorkspaceForWrite(resolved, input.flags['allow-active-workspace-write'] ?? false)
    if (!input.flags['allow-mutations']) {
      throw new LinearAgentError({
        code: 'RAW_MUTATION_REQUIRES_FLAG',
        message:
          'mutation queries require --allow-mutations to prevent accidental data modification',
      })
    }
  }

  // Step 7: load vars (inline JSON or @file.json)
  const vars = await loadVars(input.flags.vars)

  // Step 8: dispatch via rawRequest wrapped in fetch interception + rate-limit retry
  if (input.mockRawRequest) {
    // Test seam: bypass actual client construction
    const response = (await input.mockRawRequest(queryText, vars as Record<string, unknown>)) as {
      data?: unknown
      error?: string
    }
    if (response.error !== undefined || response.data === undefined) {
      // WR-05: scrub token-shaped substrings before constructing the
      // LinearAgentError — its constructor throws on `lin_api_*` /
      // `lin_oauth_*` substrings (defense in depth).
      const safeMessage = redact(response.error ?? 'graphql request returned no data')
      const safeCause = response.error !== undefined ? redact(response.error) : undefined
      throw new LinearAgentError({
        code: 'LINEAR_API_ERROR',
        message: safeMessage,
        details: { kind: 'graphql-runtime', cause: safeCause },
      })
    }
    const complexity = getLastComplexity()
    return {
      data: response.data,
      meta: {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        ...(complexity !== undefined ? { complexity } : {}),
      },
    }
  }

  const client = createLinearClient(resolved)
  return withFetchInterception(async () => {
    const response = (await withRateLimitRetry(() =>
      client.client.rawRequest(queryText, vars as Record<string, unknown>),
    )) as { data?: unknown; error?: string }
    if (response.error !== undefined || response.data === undefined) {
      // WR-05: scrub token-shaped substrings before constructing the
      // LinearAgentError (see comment above).
      const safeMessage = redact(response.error ?? 'graphql request returned no data')
      const safeCause = response.error !== undefined ? redact(response.error) : undefined
      throw new LinearAgentError({
        code: 'LINEAR_API_ERROR',
        message: safeMessage,
        details: { kind: 'graphql-runtime', cause: safeCause },
      })
    }
    const complexity = getLastComplexity()
    return {
      data: response.data,
      meta: {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        ...(complexity !== undefined ? { complexity } : {}),
      },
    }
  })
}

/**
 * Load query text from inline string or @file.graphql reference.
 * If the query starts with '@', treat the rest as a filesystem path.
 */
async function loadQueryText(query: string): Promise<string> {
  if (!query.startsWith('@')) {
    return query
  }
  const filePath = query.slice(1)
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new LinearAgentError({
      code: 'GRAPHQL_QUERY_FILE_NOT_FOUND',
      message: `query file not found or not readable: ${filePath}`,
      details: {
        path: filePath,
        cause: code ?? (err as Error).message,
      },
    })
  }
}

/**
 * Load vars from inline JSON string or @file.json reference.
 * File reference takes precedence if both are provided (file path starts with '@').
 * Returns an empty object if no vars provided.
 *
 * Note: This helper is intentionally duplicated from raw-runtime (not shared)
 * to maintain cross-plan independence for wave-2 parallel execution (03-02 and
 * 03-03 run concurrently; sharing a helper file would create ordering constraints).
 */
async function loadVars(vars: string | undefined): Promise<Record<string, unknown>> {
  if (!vars) return {}
  if (vars.startsWith('@')) {
    const filePath = vars.slice(1)
    try {
      const text = await readFile(filePath, 'utf8')
      return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      throw new LinearAgentError({
        code: 'RAW_VARS_INVALID',
        message: `failed to read or parse vars file: ${filePath}`,
        details: { path: filePath, cause: (err as Error).message },
      })
    }
  }
  try {
    return JSON.parse(vars) as Record<string, unknown>
  } catch (err) {
    throw new LinearAgentError({
      code: 'RAW_VARS_INVALID',
      message: 'failed to parse --vars as JSON',
      details: { cause: (err as Error).message },
    })
  }
}
