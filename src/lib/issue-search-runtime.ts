/**
 * `issue search` runtime — Phase 2 PLAN 02-05 Task 2, ISS-07.
 *
 * Full-text search via `client.searchIssues(term, vars)` — the canonical
 * SDK method per RESEARCH item 2. Older planning docs reference a
 * Snippets-suffixed variant that does NOT exist in @linear/sdk v83;
 * this runtime uses the only real method.
 *
 * Read command — no WSP-06 gate. Filter parity with `issue list` via
 * `buildIssueFilter` from 02-01 (state / assignee / team / label / project
 * / cycle).
 *
 * Snippet handling: `IssueSearchResult.metadata` is a JSONObject Linear
 * uses to attach highlight context. The default --fields preset includes
 * `snippet` (Wave 1 added it to ALLOWED_FIELDS.issue), and the runtime
 * copies `result.metadata.snippet` to a top-level `snippet` field BEFORE
 * projection so `--fields=snippet` resolves cleanly. `--no-snippet` skips
 * that copy, leaving the field absent (and projecting to `null`).
 *
 * Hydration mirrors `issue-list-runtime.ts` -- Linear's IssueSearchResult
 * is shaped like an Issue and exposes the same lazy relation getters
 * (state, assignee, team, project, cycle, parent), so we await each only
 * when the projection spec asks for it.
 *
 * Error envelopes:
 *   - INVALID_FIELD (exit 12) -- unknown --fields path.
 *   - USAGE_ERROR  (exit 2)   -- --limit out of range.
 *   - LINEAR_API_ERROR / RATELIMITED / NETWORK_ERROR / AUTH_INVALID --
 *     via the transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { buildIssueFilter, type IssueFilterShape } from '@/lib/filter-heuristics.js'

export interface IssueSearchArgs {
  /** Full-text search query. Required. */
  query: string
}

export interface IssueSearchFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  // Filter parity with `issue list`.
  state?: string
  assignee?: string
  team?: string
  label?: string
  project?: string
  cycle?: string
  /** Drop the snippet metadata from the projection. Default false. */
  noSnippet?: boolean
  /** Pass through to vars.includeArchived. Default false. */
  includeArchived?: boolean
}

export interface IssueSearchInput {
  args: IssueSearchArgs
  flags: IssueSearchFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface IssueSearchOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SearchVars {
  first: number
  after?: string
  filter?: IssueFilterShape
  includeArchived?: boolean
}

interface SdkSearchPayload {
  totalCount: number
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

export async function issueSearchRuntime(input: IssueSearchInput): Promise<IssueSearchOutput> {
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

  return withFetchInterception(async () => {
    const vars: SearchVars = { first }
    if (after !== undefined) vars.after = after
    if (filter !== undefined) vars.filter = filter
    if (input.flags.includeArchived === true) vars.includeArchived = true

    const payload = (await withRateLimitRetry(
      () =>
        client.searchIssues(
          input.args.query,
          vars as unknown as Parameters<LinearClient['searchIssues']>[1],
        ),
      input.retryOptsOverride,
    )) as unknown as SdkSearchPayload

    const noSnippet = input.flags.noSnippet === true
    const projected = await Promise.all(
      payload.nodes.map(async (result) => {
        // Copy snippet from metadata to a top-level field BEFORE projection
        // so `--fields=snippet` resolves. The metadata object is read once
        // and never deeply walked -- we only surface metadata.snippet.
        const issue: Record<string, unknown> = { ...result }
        if (!noSnippet) {
          const md = (result as { metadata?: unknown }).metadata
          if (md && typeof md === 'object') {
            const snippetVal = (md as Record<string, unknown>).snippet
            if (typeof snippetVal === 'string') {
              issue.snippet = snippetVal
            }
          }
        }
        const hydrated = await hydrateForProjection(issue, fields)
        return project(hydrated, fields)
      }),
    )

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      pageInfo: {
        hasNextPage: Boolean(payload.pageInfo?.hasNextPage),
        endCursor: payload.pageInfo?.endCursor ?? null,
        hasPreviousPage: Boolean(payload.pageInfo?.hasPreviousPage),
        startCursor: payload.pageInfo?.startCursor ?? null,
      },
      totalCount: payload.totalCount,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data: projected, meta }
  })
}

// -----------------------------------------------------------------------------
// Lazy-property hydration -- mirrors issue-list-runtime.ts:154-204.
// IssueSearchResult is Issue-shaped (per RESEARCH); same lazy getters apply.
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['state', 'assignee', 'team', 'project', 'cycle', 'parent'])

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

function neededRelations(spec: ProjectionSpec): Set<string> {
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
