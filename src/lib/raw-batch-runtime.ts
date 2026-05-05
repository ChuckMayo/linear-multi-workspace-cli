/**
 * `raw batch` runtime — Phase 3 PLAN 03-05, RAW-05.
 *
 * Safety-gated batch dispatcher. Runs a JSON plan of operations in sequence.
 * Owns:
 *   - RAW-05: `raw batch --plan=@file.json` with default dry-run + explicit --yes to execute
 *
 * **9-step pipeline:**
 *   1. resolveWorkspace (S2 verbatim)
 *   2. Validate plan flag has @ prefix → load + parse + Zod-validate → BATCH_PLAN_INVALID
 *   3. Registry lookup each entry's operation → BATCH_PLAN_INVALID with details.entry_index on miss
 *   4. Compute kinds = { query: N, mutation: M }
 *   5. If M > 0: requireExplicitWorkspaceForWrite (WSP-06 FIRST — Pitfall 7)
 *   6. If M > 0 && !allow-mutations: RAW_MUTATION_REQUIRES_FLAG
 *   7. Determine intent:
 *      - dryRun = flags['dry-run'] !== false (default true; --dry-run --yes still dry-run)
 *      - if dryRun: emit dry-run envelope; STOP (ZERO SDK calls)
 *      - if !dryRun && !yes: BATCH_REQUIRES_YES (exit 2)
 *      - if !dryRun && yes: dispatch sequentially via runRaw
 *   8. Sequential dispatch (NOT parallel — RESEARCH line 769; keeps rate-limit pressure manageable)
 *   9. Aggregate results; top-level ok:true (batch ran); per-entry ok:false on failure
 *
 * **Threat mitigations:**
 *   - T-03-05-WSP06: WSP-06 fires AFTER plan validation but BEFORE any dispatch (Pitfall 7)
 *   - T-03-05-DRY-RUN: --dry-run is the DEFAULT; both --dry-run + --yes → still dry-run
 *   - T-03-05-PLAN-FILE-INJECTION: Zod validates plan shape; max(100) caps blast radius (Pitfall 6)
 *   - T-03-05-D-RATELIMIT: Sequential dispatch + 100-entry cap
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from '@/core/config/index.js'
import { loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { OPERATION_REGISTRY } from '@/generated/operations.js'
import { runRaw } from './raw-runtime.js'

// ---------------------------------------------------------------------------
// Plan validation schema (Pitfall 6: max(100) cap)
// ---------------------------------------------------------------------------

const PlanEntrySchema = z.object({
  operation: z.string(),
  vars: z.record(z.string(), z.unknown()),
})

// Cap at 100 to bound blast radius (Pitfall 6)
const PlanSchema = z.array(PlanEntrySchema).min(1).max(100)

type PlanEntry = z.infer<typeof PlanEntrySchema>

// ---------------------------------------------------------------------------
// Flags interface
// ---------------------------------------------------------------------------

export interface RunRawBatchFlags {
  workspace?: string
  'allow-active-workspace-write'?: boolean
  'allow-mutations'?: boolean
  /** Required — must be an @file.json path (@ prefix enforced). */
  plan: string
  /** Default true; pass false (--no-dry-run) to enable execution mode. */
  'dry-run'?: boolean
  /** Required to execute when --no-dry-run is passed. */
  yes?: boolean
  pretty?: boolean
}

// ---------------------------------------------------------------------------
// Output interface
// ---------------------------------------------------------------------------

export interface RunRawBatchOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

// ---------------------------------------------------------------------------
// Input interface
// ---------------------------------------------------------------------------

export interface RunRawBatchInput {
  flags: RunRawBatchFlags
  env?: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runRawBatch(input: RunRawBatchInput): Promise<RunRawBatchOutput> {
  const { flags, env = process.env } = input
  const config = (input.loadConfigOverride ?? loadConfig)()

  // Step 1: resolveWorkspace (S2 verbatim from issue-purge-runtime.ts:85-99)
  const envForResolver: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string } = {}
  if (env.LINEAR_WORKSPACE !== undefined) envForResolver.LINEAR_WORKSPACE = env.LINEAR_WORKSPACE
  if (env.LINEAR_API_KEY !== undefined) envForResolver.LINEAR_API_KEY = env.LINEAR_API_KEY
  const resolveFlags = flags.workspace ? { workspace: flags.workspace } : {}
  const resolved = resolveWorkspace({ flags: resolveFlags, env: envForResolver, config })

  // Step 2: Load + parse + Zod-validate plan file
  const plan = await loadAndValidatePlan(flags.plan)

  // Step 3: Registry lookup each entry's operation → BATCH_PLAN_INVALID on miss
  const registry = OPERATION_REGISTRY as Record<
    string,
    { kind: string; source: string; varsSchema: z.ZodType }
  >
  const enriched = plan.map((entry, index) => {
    const reg = registry[entry.operation]
    if (!reg) {
      throw new LinearAgentError({
        code: 'BATCH_PLAN_INVALID',
        message: `entry ${index}: unknown operation '${entry.operation}'`,
        details: {
          entry_index: index,
          reason: `unknown_operation: '${entry.operation}' not in OPERATION_REGISTRY`,
          operation: entry.operation,
        },
      })
    }
    return { ...entry, kind: reg.kind as 'query' | 'mutation' }
  })

  // Step 4: Compute kinds
  const kinds = {
    query: enriched.filter((e) => e.kind === 'query').length,
    mutation: enriched.filter((e) => e.kind === 'mutation').length,
  }
  const batchMeta = { count: enriched.length, kinds }

  // Step 5: WSP-06 — only if any mutation present (Pitfall 7)
  // Fires AFTER plan validation but BEFORE any per-entry dispatch
  if (kinds.mutation > 0) {
    requireExplicitWorkspaceForWrite(resolved, flags['allow-active-workspace-write'] ?? false)
  }

  // Step 6: --allow-mutations check (after WSP-06 — second gate)
  if (kinds.mutation > 0 && !flags['allow-mutations']) {
    throw new LinearAgentError({
      code: 'RAW_MUTATION_REQUIRES_FLAG',
      message: `batch contains ${kinds.mutation} mutation(s) and requires --allow-mutations`,
      details: { mutation_count: kinds.mutation },
    })
  }

  // Step 7: Determine intent
  // dryRun = flags['dry-run'] !== false (default true; --dry-run --yes STILL dry-run — RESEARCH line 774)
  const dryRun = flags['dry-run'] !== false

  if (dryRun) {
    // Dry-run: return plan preview with ZERO SDK calls
    return {
      data: {
        plan: enriched.map((e) => ({
          operation: e.operation,
          vars: e.vars,
          kind: e.kind,
          workspace: resolved.name,
        })),
      },
      meta: {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        batch: batchMeta,
      },
    }
  }

  // Need --yes to execute (--no-dry-run alone is not enough)
  if (!flags.yes) {
    throw new LinearAgentError({
      code: 'BATCH_REQUIRES_YES',
      message:
        'batch execution requires --yes to confirm (or remove --no-dry-run for a dry-run preview)',
      details: {
        hint: 'pass --yes to confirm execution, or remove --no-dry-run for a dry-run preview',
      },
    })
  }

  // Step 8: Sequential dispatch (NOT parallel — RESEARCH line 769)
  const results: Array<{
    ok: boolean
    operation: string
    data?: unknown
    error?: { code: string; message: string; details?: unknown }
  }> = []

  for (const entry of enriched) {
    try {
      const result = await runRaw({
        args: { operation: entry.operation },
        flags: {
          workspace: flags.workspace,
          'allow-active-workspace-write': flags['allow-active-workspace-write'],
          'allow-mutations': flags['allow-mutations'],
          vars: JSON.stringify(entry.vars),
        },
        env,
        loadConfigOverride: input.loadConfigOverride,
      })
      results.push({ ok: true, operation: entry.operation, data: result.data })
    } catch (err) {
      if (err instanceof LinearAgentError) {
        results.push({
          ok: false,
          operation: entry.operation,
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        })
      } else {
        // Non-LinearAgentError (e.g., from a mocked throw)
        const e = err as Error & { code?: string }
        results.push({
          ok: false,
          operation: entry.operation,
          error: {
            code: e.code ?? 'GENERIC_ERROR',
            message: e.message ?? 'unknown error',
          },
        })
      }
    }
  }

  // Step 9: top-level ok:true (batch ran); per-entry ok in data.results
  return {
    data: { results },
    meta: {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      batch: batchMeta,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load, parse, and Zod-validate the plan file.
 * Plan flag MUST start with '@' (it's a required file ref).
 */
async function loadAndValidatePlan(planFlag: string): Promise<PlanEntry[]> {
  // Enforce @ prefix requirement
  if (!planFlag.startsWith('@')) {
    throw new LinearAgentError({
      code: 'BATCH_PLAN_INVALID',
      message: `--plan must be an @file path (e.g. --plan=@plan.json); got: '${planFlag}'`,
      details: { reason: '@file path required: prefix the path with @' },
    })
  }

  const filePath = planFlag.slice(1)

  // Read the file
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf8')
  } catch (err) {
    // BL-04 fix: catch ALL filesystem errors (EACCES permission denied,
    // EISDIR user passed a directory, EPERM, ENOENT, etc.), not just
    // ENOENT. A bare Error would escape to GENERIC_ERROR and break the
    // typed-envelope contract.
    const code = (err as NodeJS.ErrnoException).code
    throw new LinearAgentError({
      code: 'BATCH_PLAN_INVALID',
      message: `plan file not found or not readable: ${filePath}`,
      details: {
        path: filePath,
        reason: 'file_not_readable',
        cause: code ?? (err as Error).message,
      },
    })
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (err) {
    throw new LinearAgentError({
      code: 'BATCH_PLAN_INVALID',
      message: `plan file is not valid JSON: ${(err as Error).message}`,
      details: { reason: 'parse_error' },
    })
  }

  // Zod validation (shape + min/max)
  const result = PlanSchema.safeParse(parsed)
  if (!result.success) {
    // Try to extract entry_index from Zod issue path
    const firstIssue = result.error.issues[0]
    const entryIndex =
      firstIssue?.path[0] !== undefined && typeof firstIssue.path[0] === 'number'
        ? firstIssue.path[0]
        : undefined

    const details: Record<string, unknown> = {
      reason: firstIssue?.message ?? 'validation_failed',
    }
    if (entryIndex !== undefined) details.entry_index = entryIndex

    throw new LinearAgentError({
      code: 'BATCH_PLAN_INVALID',
      message: `plan file validation failed: ${firstIssue?.message ?? 'invalid shape'}`,
      details,
    })
  }

  return result.data
}
