/**
 * `raw <Operation>` runtime — Phase 3 PLAN 03-02, RAW-01 / RAW-02.
 *
 * Dispatches any operation in the generated GraphQL registry via
 * `client.client.rawRequest(entry.source, vars)`. Owns:
 *   - RAW-01: full registry surface (501 ops) accessible from CLI
 *   - RAW-02: mutation safety with WSP-06 + --allow-mutations gates
 *
 * **Gate ordering is load-bearing (Test 3 — WSP-06 BEFORE --allow-mutations):**
 *   1. resolveWorkspace
 *   2. registry lookup (RAW_OPERATION_NOT_FOUND on miss; closest-match suggestions)
 *   3. subscription guard (OPERATION_SUBSCRIPTIONS_UNSUPPORTED — defensive)
 *   4. requireExplicitWorkspaceForWrite (WSP-06 FIRST — precedent: issue-purge-runtime.ts:99 Test 11)
 *   5. --allow-mutations check (RAW_MUTATION_REQUIRES_FLAG)
 *   6. vars parse + Zod validation (RAW_VARS_INVALID)
 *   7. createLinearClient
 *   8. client.client.rawRequest(entry.source, vars) wrapped in S3 transport
 *   9. response.error → LINEAR_API_ERROR (Pitfall 2: STRING not LinearError instance)
 *   10. meta build with opt-in complexity spread + return envelope
 *
 * Why WSP-06 first: a missing --workspace is the more dangerous mistake
 * (cross-workspace permanent write) vs a missing --allow-mutations flag.
 * Test 3 pins this ordering. Precedent: issue-purge-runtime.ts:99 Test 11.
 *
 * Pitfall 2 (RESEARCH § Pitfall 2): `client.client.rawRequest` does NOT
 * throw on GraphQL errors — it returns `LinearRawResponse` with `error?`
 * populated as a STRING. withRateLimitRetry still handles HTTP-layer
 * rate-limits via `instanceof RatelimitedLinearError`. Runtime checks
 * `response.error` explicitly → LINEAR_API_ERROR with `details.cause`.
 */
import { readFile } from 'node:fs/promises'
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { OPERATION_REGISTRY } from '@/generated/operations.js'

export interface RunRawArgs {
  /** PascalCase operation name from the registry (e.g. Issues, IssueCreate). */
  operation: string
}

export interface RunRawFlags {
  workspace?: string
  /** Per-invocation WSP-06 opt-in for active/single workspace on mutations. */
  'allow-active-workspace-write'?: boolean
  /** Required for mutation operations — explicit safety gate. */
  'allow-mutations'?: boolean
  /** Variables as inline JSON or @file.json (file takes precedence). */
  vars?: string
  /** Optional comma-separated field projection applied post-execution. */
  fields?: string
  pretty?: boolean
}

export interface RunRawInput {
  args: RunRawArgs
  flags: RunRawFlags
  env?: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface RunRawOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

export async function runRaw(input: RunRawInput): Promise<RunRawOutput> {
  const config = (input.loadConfigOverride ?? loadConfig)()
  const env = input.env ?? process.env

  // S2: workspace resolver boilerplate (verbatim from issue-purge-runtime.ts:85-99)
  const envForResolver: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string } = {}
  if (env.LINEAR_WORKSPACE !== undefined) envForResolver.LINEAR_WORKSPACE = env.LINEAR_WORKSPACE
  if (env.LINEAR_API_KEY !== undefined) envForResolver.LINEAR_API_KEY = env.LINEAR_API_KEY
  const resolveFlags = input.flags.workspace ? { workspace: input.flags.workspace } : {}
  const resolved = resolveWorkspace({ flags: resolveFlags, env: envForResolver, config })

  // Step 2: Registry lookup (RAW_OPERATION_NOT_FOUND with closest-match suggestions on miss)
  const registry = OPERATION_REGISTRY as Record<
    string,
    (typeof OPERATION_REGISTRY)[keyof typeof OPERATION_REGISTRY]
  >
  const entry = registry[input.args.operation]
  if (!entry) {
    const suggestions = suggestClosest(input.args.operation, Object.keys(registry))
    throw new LinearAgentError({
      code: 'RAW_OPERATION_NOT_FOUND',
      message: `unknown operation: ${input.args.operation}. Did you mean: ${suggestions.join(', ')}?`,
      details: { operation: input.args.operation, suggestions },
    })
  }

  // Step 3: Subscription guard (defensive — real codegen excludes them, but guard anyway)
  if ((entry.kind as string) === 'subscription') {
    throw new LinearAgentError({
      code: 'OPERATION_SUBSCRIPTIONS_UNSUPPORTED',
      message: `subscription operations are not supported: ${input.args.operation}`,
      details: { operation: input.args.operation, kind: 'subscription' },
    })
  }

  // Step 4: WSP-06 FIRST (before --allow-mutations check — THE load-bearing ordering)
  if (entry.kind === 'mutation') {
    requireExplicitWorkspaceForWrite(resolved, input.flags['allow-active-workspace-write'] ?? false)
  }

  // Step 5: --allow-mutations check (after WSP-06 — second gate)
  if (entry.kind === 'mutation' && !input.flags['allow-mutations']) {
    throw new LinearAgentError({
      code: 'RAW_MUTATION_REQUIRES_FLAG',
      message: `mutation '${input.args.operation}' requires --allow-mutations`,
      details: { operation: input.args.operation, kind: 'mutation' },
    })
  }

  // Step 6: Parse + Zod-validate vars (RAW_VARS_INVALID on failure)
  const rawVars = await loadVars(input.flags.vars)
  const parsed = entry.varsSchema.safeParse(rawVars)
  if (!parsed.success) {
    throw new LinearAgentError({
      code: 'RAW_VARS_INVALID',
      message: `vars failed validation for operation '${input.args.operation}'`,
      details: {
        operation: input.args.operation,
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      },
    })
  }

  // Step 7: Create client
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  // Steps 8-10: Dispatch + check response + build meta (S3 transport pattern)
  return withFetchInterception(async () => {
    const response = (await withRateLimitRetry(
      () => client.client.rawRequest(entry.source, parsed.data as Record<string, unknown>),
      input.retryOptsOverride,
    )) as { data?: unknown; error?: string; status?: number }

    // Step 9: Pitfall 2 — response.error is a STRING, not a LinearError instance.
    // withRateLimitRetry handles HTTP-layer rate-limits; this checks GraphQL-layer errors.
    if (response.error !== undefined || response.data === undefined) {
      throw new LinearAgentError({
        code: 'LINEAR_API_ERROR',
        message:
          response.error ?? `rawRequest returned no data for operation '${input.args.operation}'`,
        details: {
          cause: response.error,
          operation: input.args.operation,
          status: response.status,
        },
      })
    }

    // Step 10: Build meta with opt-in complexity spread (S3 pattern)
    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data: response.data, meta }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load and parse vars from inline JSON string or @file.json path.
 * File path takes precedence (CONTEXT.md line 51 contract).
 */
async function loadVars(varsArg: string | undefined): Promise<unknown> {
  if (!varsArg) return {}

  if (varsArg.startsWith('@')) {
    const path = varsArg.slice(1)
    try {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LinearAgentError({
          code: 'GRAPHQL_QUERY_FILE_NOT_FOUND',
          message: `vars file not found: ${path}`,
          details: { path },
        })
      }
      throw err
    }
  }

  try {
    return JSON.parse(varsArg)
  } catch (err) {
    throw new LinearAgentError({
      code: 'RAW_VARS_INVALID',
      message: `--vars is not valid JSON: ${(err as Error).message}`,
      details: { reason: 'parse_error' },
    })
  }
}

/**
 * Return the top `limit` closest operation names to `missing` by Levenshtein distance.
 * Inlined ~20 LOC — no new dependency.
 */
function suggestClosest(missing: string, names: string[], limit = 3): string[] {
  return names
    .map((n) => ({ name: n, d: levenshtein(missing.toLowerCase(), n.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.name)
}

/**
 * Simple iterative Levenshtein distance.
 * Uses flat typed array to avoid biome noNonNullAssertion warnings on 2D indexing.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  // Flat row-major array: dp[i][j] = dp[i * (n+1) + j]
  const dp = new Int32Array((m + 1) * (n + 1))
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1
      const del = (dp[(i - 1) * (n + 1) + j] ?? i) + 1
      const ins = (dp[i * (n + 1) + (j - 1)] ?? j) + 1
      const rep = (dp[(i - 1) * (n + 1) + (j - 1)] ?? i + j) + sub
      dp[i * (n + 1) + j] = Math.min(del, ins, rep)
    }
  }
  return dp[m * (n + 1) + n] ?? 0
}
