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
 *   5. buildIssueFilter(flags) → IssueFilter | undefined
 *      (UUID/email/key heuristics for state/assignee/team).
 *   6. await client.issues({ first, after, filter }) — typed SDK call.
 *   7. Hydrate lazy entities (issue.state, issue.assignee, issue.team) on
 *      demand based on which paths the projection spec actually needs.
 *      Phase 2's transport-wrapper rewrite will replace this per-issue await
 *      with a single fragment query (PITFALLS § Pitfall 14 — N+1).
 *   8. project(hydrated, spec) per issue.
 *   9. Return { data, meta } with pageInfo mirrored verbatim.
 *
 * Error handling: any thrown error from the SDK is funneled through
 * `classifyIssueListError(raw)` into a `LinearAgentError` with the right
 * code (KRN-09 taxonomy). `LinearAgentError` instances flow through
 * unchanged (resolver/parser already classify their own errors).
 */

import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'

export interface IssueListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  state?: string
  assignee?: string
  team?: string
}

export interface IssueListInput {
  flags: IssueListFlags
  env: NodeJS.ProcessEnv
  /** Test-only seam — defaults to `loadConfig()`. */
  loadConfigOverride?: () => Config
  /** Test-only seam — defaults to `createLinearClient`. */
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
}

export interface IssueListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  let connection: SdkIssueConnection
  try {
    const issuesArgs: { first: number; after?: string; filter?: IssueFilterShape } = { first }
    if (after !== undefined) issuesArgs.after = after
    if (filter !== undefined) issuesArgs.filter = filter
    connection = (await client.issues(
      issuesArgs as unknown as Parameters<LinearClient['issues']>[0],
    )) as unknown as SdkIssueConnection
  } catch (raw) {
    throw classifyIssueListError(raw)
  }

  const projected = await Promise.all(
    connection.nodes.map(async (issue) => {
      const hydrated = await hydrateForProjection(issue, fields)
      return project(hydrated, fields)
    }),
  )

  const meta: Omit<Meta, 'command'> = {
    workspace: resolved.name,
    workspaceSource: resolved.source,
    pageInfo: {
      hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
      endCursor: connection.pageInfo?.endCursor ?? null,
      hasPreviousPage: Boolean(connection.pageInfo?.hasPreviousPage),
      startCursor: connection.pageInfo?.startCursor ?? null,
    },
  }

  return { data: projected, meta }
}

// -----------------------------------------------------------------------------
// Filter builder
// -----------------------------------------------------------------------------

interface IssueFilterShape {
  state?: { id?: { eq: string }; name?: { eq: string } }
  assignee?: { id?: { eq: string }; email?: { eq: string }; isMe?: { eq: boolean } }
  team?: { id?: { eq: string }; key?: { eq: string }; name?: { eq: string } }
}

function buildIssueFilter(flags: IssueListFlags): IssueFilterShape | undefined {
  const filter: IssueFilterShape = {}

  if (flags.state) {
    filter.state = UUID_RE.test(flags.state)
      ? { id: { eq: flags.state } }
      : { name: { eq: flags.state } }
  }

  if (flags.assignee) {
    if (flags.assignee === 'me') {
      filter.assignee = { isMe: { eq: true } }
    } else if (EMAIL_RE.test(flags.assignee)) {
      filter.assignee = { email: { eq: flags.assignee } }
    } else if (UUID_RE.test(flags.assignee)) {
      filter.assignee = { id: { eq: flags.assignee } }
    } else {
      // Default: treat unknown shapes as email (most common Linear-public ID).
      filter.assignee = { email: { eq: flags.assignee } }
    }
  }

  if (flags.team) {
    if (UUID_RE.test(flags.team)) {
      filter.team = { id: { eq: flags.team } }
    } else if (/^[A-Z0-9]{2,6}$/i.test(flags.team)) {
      filter.team = { key: { eq: flags.team.toUpperCase() } }
    } else {
      filter.team = { name: { eq: flags.team } }
    }
  }

  if (Object.keys(filter).length === 0) return undefined
  return filter
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
// Error classifier — maps SDK errors to the kernel taxonomy (KRN-09)
// -----------------------------------------------------------------------------

const RATELIMIT_DEFAULT_RETRY_MS = 30_000

export function classifyIssueListError(raw: unknown): LinearAgentError {
  if (raw instanceof LinearAgentError) return raw
  const msg = raw instanceof Error ? raw.message : String(raw)

  // Rate-limit shape: error.errors[0].extensions.code === 'RATELIMITED'
  // (PITFALLS § Pitfall 5 — Linear returns rate limits as 400 with code in errors[]).
  const rl = extractGraphqlCode(raw)
  if (rl === 'RATELIMITED') {
    return LinearAgentError.rateLimited(RATELIMIT_DEFAULT_RETRY_MS)
  }

  // Auth-shaped errors → AUTH_INVALID
  if (
    /\b401\b/.test(msg) ||
    /authentication/i.test(msg) ||
    /unauthorized/i.test(msg) ||
    /invalid api key/i.test(msg) ||
    /token is invalid/i.test(msg)
  ) {
    return LinearAgentError.auth.invalid('token rejected by Linear')
  }

  // Network-shaped errors → NETWORK_ERROR (transient: true)
  if (
    /\bENOTFOUND\b/.test(msg) ||
    /\bECONNREFUSED\b/.test(msg) ||
    /\bETIMEDOUT\b/.test(msg) ||
    /\bECONNRESET\b/.test(msg) ||
    /\bEAI_AGAIN\b/.test(msg) ||
    /fetch failed/i.test(msg) ||
    /network error/i.test(msg) ||
    /\bdns\b/i.test(msg)
  ) {
    return LinearAgentError.network('network error during Linear API call')
  }

  // Validation-shaped errors → VALIDATION_FAILED (exit 12)
  if (rl === 'INVALID_INPUT' || /argument value/i.test(msg) || /is not valid/i.test(msg)) {
    return LinearAgentError.validation.failed('Linear rejected the request payload', {
      cause: msg,
    })
  }

  // Default: LINEAR_API_ERROR (exit 13)
  return LinearAgentError.linear.apiError({
    message: 'Linear API call failed',
    details: { cause: msg },
  })
}

function extractGraphqlCode(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && 'errors' in raw) {
    const arr = (raw as { errors?: Array<{ extensions?: { code?: string } }> }).errors
    if (Array.isArray(arr) && arr.length > 0) {
      return arr[0]?.extensions?.code
    }
  }
  return undefined
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
