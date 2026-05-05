/**
 * `issue list` runtime — the testable seam for the first vertical slice.
 *
 * Why a separate `src/lib/` file instead of `src/commands/issue/_runtime.ts`?
 * oclif's manifest generator scans every file under `src/commands/` as a
 * Command class — a non-Command export at that path crashes `oclif manifest`
 * (the same trap PLAN-04 hit with `_shared.ts`). Helpers live in `src/lib/`,
 * which `tsdown.config.ts` already includes via the `src/lib` entry glob.
 *
 * Pipeline (CONTEXT § `issue list` — First Vertical Slice):
 *   1. resolveWorkspace({ flags, env, config }) — workspace selection
 *      (PLAN-03's pure 6-step precedence chain).
 *   2. createLinearClient(resolved) — fresh `@linear/sdk` LinearClient
 *      (PLAN-03 KRN-05 — never cached).
 *   3. parseFields(input.flags.fields, 'issue') — projection spec
 *      (PLAN-05 KRN-08 — INVALID_FIELD on unknown paths).
 *   4. parsePagination({ limit, cursor }) → { first, after }
 *      (PLAN-05 KRN-08 — USAGE_ERROR on out-of-range limit).
 *   5. buildIssueFilter(flags) → IssueFilter | undefined  (extracted to
 *      `@/lib/filter-heuristics.js` in Phase 2 PLAN 02-01 so issue search
 *      and future entity lists share the routing without drift).
 *   6. await client.issues({ first, after, filter }) — typed SDK call,
 *      wrapped in `withRateLimitRetry` inside `withFetchInterception` so
 *      the kernel's rate-limit retry policy and complexity-meter capture
 *      both engage. The Phase 1 regex-based message-substring stopgap
 *      formerly in this file is GONE; the transport's `classifySdkError`
 *      is the canonical replacement.
 *   7. Hydrate lazy entities (issue.state, issue.assignee, issue.team) on
 *      demand based on which paths the projection spec actually needs.
 *      Phase 2's transport-wrapper rewrite still leaves the per-issue
 *      hydration in place; PITFALLS § Pitfall 14 (N+1) remains a known
 *      cliff for `--fields=full`.
 *   8. project(hydrated, spec) per issue.
 *   9. Return { data, meta } with pageInfo mirrored verbatim. `meta.complexity`
 *      is spread ONLY when `getLastComplexity()` returned a value (strict
 *      opt-in keeps Phase 1 snapshots byte-identical when tests mock the
 *      SDK class instead of `globalThis.fetch`).
 */

import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { redact } from '@/core/redact/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { buildIssueFilter, type IssueFilterShape } from '@/lib/filter-heuristics.js'
import { validateAndMergeIncludes } from '@/lib/include-fragments.js'

export interface IssueListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  state?: string
  assignee?: string
  team?: string
  /** Phase 3: hydrate related entities in a single rawRequest round-trip */
  include?: string[]
}

export interface IssueListInput {
  flags: IssueListFlags
  env: NodeJS.ProcessEnv
  /** Test-only seam — defaults to `loadConfig()`. */
  loadConfigOverride?: () => Config
  /** Test-only seam — defaults to `createLinearClient`. */
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  /** Test-only seam — passes through to `withRateLimitRetry`. */
  retryOptsOverride?: RetryOpts
}

export interface IssueListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

export async function issueListRuntime(input: IssueListInput): Promise<IssueListOutput> {
  const config = (input.loadConfigOverride ?? loadConfig)()

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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'issue')
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })
  const filter = buildIssueFilter(input.flags)

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  // Phase 3: branch on --include. Empty → unchanged Phase 2 typed-SDK call.
  const includes = input.flags.include ?? []
  if (includes.length === 0) {
    // PHASE 2 BEHAVIOR — UNCHANGED
    return withFetchInterception(async () => {
      const issuesArgs: { first: number; after?: string; filter?: IssueFilterShape } = { first }
      if (after !== undefined) issuesArgs.after = after
      if (filter !== undefined) issuesArgs.filter = filter
      const connection = (await withRateLimitRetry(
        () => client.issues(issuesArgs as unknown as Parameters<LinearClient['issues']>[0]),
        input.retryOptsOverride,
      )) as unknown as SdkIssueConnection

      const projected = await Promise.all(
        connection.nodes.map(async (issue) => {
          const hydrated = await hydrateForProjection(issue, fields)
          return project(hydrated, fields)
        }),
      )

      const complexity = getLastComplexity()
      const meta: Omit<Meta, 'command'> = {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        pageInfo: {
          hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
          endCursor: connection.pageInfo?.endCursor ?? null,
          hasPreviousPage: Boolean(connection.pageInfo?.hasPreviousPage),
          startCursor: connection.pageInfo?.startCursor ?? null,
        },
        ...(complexity !== undefined ? { complexity } : {}),
      }

      return { data: projected, meta }
    })
  }

  // PHASE 3 INCLUDE PATH — single rawRequest with inlined fragments
  const fragmentText = validateAndMergeIncludes('issue list', includes)
  const query = composeIssueListWithIncludes(fragmentText)

  return withFetchInterception(async () => {
    const vars: { filter?: IssueFilterShape; first: number; after?: string } = { first }
    if (after !== undefined) vars.after = after
    if (filter !== undefined) vars.filter = filter

    const response = (await withRateLimitRetry(
      () =>
        (
          client as unknown as {
            client: {
              rawRequest: (q: string, v: unknown) => Promise<{ data?: unknown; error?: string }>
            }
          }
        ).client.rawRequest(query, vars),
      input.retryOptsOverride,
    )) as { data?: unknown; error?: string }

    if (response.error ?? !response.data) {
      // WR-05: scrub token-shaped substrings before constructing the
      // LinearAgentError — its constructor throws on `lin_api_*` /
      // `lin_oauth_*` substrings (defense in depth).
      const safeMessage = redact(response.error ?? 'no data returned from Linear API')
      const safeCause = response.error !== undefined ? redact(response.error) : undefined
      throw LinearAgentError.linear.apiError({
        message: safeMessage,
        details: { command: 'issue list', cause: safeCause },
      })
    }

    const root = (response.data as { issues?: SdkIssueConnection }).issues
    if (!root) {
      throw LinearAgentError.linear.apiError({
        message: 'unexpected response shape: missing issues field',
        details: { command: 'issue list' },
      })
    }

    const projected = root.nodes.map((issue) => project(issue, fields))

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      pageInfo: {
        hasNextPage: Boolean(root.pageInfo?.hasNextPage),
        endCursor: root.pageInfo?.endCursor ?? null,
        hasPreviousPage: Boolean(root.pageInfo?.hasPreviousPage),
        startCursor: root.pageInfo?.startCursor ?? null,
      },
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data: projected, meta }
  })
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (Phase 1 N+1 — PITFALLS § Pitfall 14)
// -----------------------------------------------------------------------------

/**
 * The typed SDK exposes `issue.state`, `issue.assignee`, `issue.team` as
 * lazy promise getters. To project paths like `state.name`, we must `await`
 * each. We hydrate ONLY the related entities the projection spec actually
 * references — narrows N+1 surface for the common `--fields=ids` case.
 *
 * Phase 2 will replace this with a single GraphQL fragment query that pulls
 * the related entities in one round-trip; documented in PITFALLS as the
 * known scaling cliff this Phase 1 implementation deliberately accepts.
 */
async function hydrateForProjection(
  issue: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  const hydrated: Record<string, unknown> = { ...issue }

  if (needs.has('state') && hydrated.state !== undefined) {
    hydrated.state = await resolveLazy(hydrated.state)
  }
  if (needs.has('assignee') && hydrated.assignee !== undefined) {
    hydrated.assignee = await resolveLazy(hydrated.assignee)
  }
  if (needs.has('team') && hydrated.team !== undefined) {
    hydrated.team = await resolveLazy(hydrated.team)
  }
  if (needs.has('project') && hydrated.project !== undefined) {
    hydrated.project = await resolveLazy(hydrated.project)
  }
  if (needs.has('cycle') && hydrated.cycle !== undefined) {
    hydrated.cycle = await resolveLazy(hydrated.cycle)
  }
  if (needs.has('parent') && hydrated.parent !== undefined) {
    hydrated.parent = await resolveLazy(hydrated.parent)
  }

  return hydrated
}

const RELATION_KEYS = new Set(['state', 'assignee', 'team', 'project', 'cycle', 'parent'])

function neededRelations(spec: ProjectionSpec): Set<string> {
  // FULL_PRESET asks for every field — but related entities still need
  // hydration; the SDK passthrough does NOT auto-resolve lazy promise
  // properties. We don't have an authoritative list here, so for FULL we
  // hydrate the conservative known-relations set.
  if (spec === FULL_PRESET) return new Set(RELATION_KEYS)
  const out = new Set<string>()
  for (const path of spec) {
    const head = path.split('.')[0]
    if (head && RELATION_KEYS.has(head)) out.add(head)
  }
  return out
}

async function resolveLazy(value: unknown): Promise<unknown> {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    return await (value as Promise<unknown>)
  }
  return value
}

// -----------------------------------------------------------------------------
// Phase 3: compose query for --include path (Approach A — single rawRequest)
// -----------------------------------------------------------------------------

function composeIssueListWithIncludes(fragmentText: string): string {
  // BL-03 fix: widen the scalar set to match the issue ALLOWED_FIELDS
  // registry (src/core/projection/project.ts). Without this, the
  // --include branch silently returned a strict subset of --fields=full
  // (description, dueDate, estimate, sortOrder, etc. were missing).
  return `
    query IssuesWithIncludes($filter: IssueFilter, $first: Int, $after: String) {
      issues(filter: $filter, first: $first, after: $after) {
        nodes {
          id identifier title description priority priorityLabel
          estimate sortOrder number url
          createdAt updatedAt archivedAt completedAt startedAt canceledAt
          dueDate snoozedUntilAt
          state { id name type }
          assignee { id email name }
          team { id key name }
          project { id name }
          cycle { id number }
          parent { id identifier }
          ${fragmentText}
        }
        pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
      }
    }
  `.trim()
}

// -----------------------------------------------------------------------------
// Minimal SDK shape-types (we don't import the full @linear/sdk types here —
// the runtime's contract with the SDK is intentionally narrow).
// -----------------------------------------------------------------------------

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}
