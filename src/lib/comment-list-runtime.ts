/**
 * `comment list` runtime — Phase 2 PLAN 02-06 Task 1, CMT-01.list.
 *
 * Read command. Lists comments either workspace-wide or scoped to a single
 * issue (--issue ENG-123 or UUID). Wraps `client.comments({ first, after,
 * filter? })` in `withRateLimitRetry` inside `withFetchInterception`. Uses
 * `parseFields(input, 'comment')` for projection, with the 02-01 default
 * preset (8 fields including `user.email`, `user.name`, `issue.identifier`,
 * `parent.id`).
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'comment')
 *   3. parsePagination -> { first, after }
 *   4. If --issue: resolve to UUID (UUID passthrough OR ENG-N -> client.issues
 *      filter), build `filter: { issue: { id: { eq: <uuid> } } }`.
 *   5. withFetchInterception(async () => withRateLimitRetry(client.comments(...)))
 *   6. Hydrate lazy relations (user, issue, parent) ONLY when projection
 *      references them -- narrows N+1 surface.
 *   7. project + meta with pageInfo, opt-in complexity.
 *
 * Error envelopes:
 *   - ISSUE_NOT_FOUND (exit 13) -- --issue resolves to nothing.
 *   - INVALID_FIELD (exit 2) -- unknown --fields path.
 *   - USAGE_ERROR (exit 2) -- invalid --limit.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement. Reads are allowed against
 * the active default workspace.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
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
import { ISSUE_IDENTIFIER_RE, UUID_RE } from '@/lib/filter-heuristics.js'

export interface CommentListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
  /** Filter to comments on this issue (UUID or ENG-N). */
  issue?: string
}

export interface CommentListInput {
  flags: CommentListFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CommentListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SdkCommentConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

interface SdkIssueConnection {
  nodes: Array<{ id: string }>
}

interface CommentIssueIdFilter {
  issue: { id: { eq: string } }
}

export async function commentListRuntime(input: CommentListInput): Promise<CommentListOutput> {
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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'comment')
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    let issueIdFilter: CommentIssueIdFilter | undefined
    if (input.flags.issue !== undefined && input.flags.issue !== '') {
      const issueUuid = await resolveIssueRefToUuid(
        client,
        input.flags.issue,
        input.retryOptsOverride,
      )
      issueIdFilter = { issue: { id: { eq: issueUuid } } }
    }

    const commentsArgs: { first: number; after?: string; filter?: CommentIssueIdFilter } = { first }
    if (after !== undefined) commentsArgs.after = after
    if (issueIdFilter !== undefined) commentsArgs.filter = issueIdFilter

    const connection = (await withRateLimitRetry(
      () => client.comments(commentsArgs as unknown as Parameters<LinearClient['comments']>[0]),
      input.retryOptsOverride,
    )) as unknown as SdkCommentConnection

    const projected = await Promise.all(
      connection.nodes.map(async (node) => {
        const hydrated = await hydrateForProjection(node, fields)
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

/**
 * Resolve a user-typed issue ref (ENG-123 or UUID) to a UUID.
 * UUID path is a no-op (no SDK round-trip); identifier path uses the
 * team-key + number filter against client.issues.
 */
async function resolveIssueRefToUuid(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref
  const m = ISSUE_IDENTIFIER_RE.exec(ref)
  if (!m) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `invalid issue ref: ${ref}`,
      details: { ref },
    })
  }
  const teamKey = (m[1] as string).toUpperCase()
  const number = Number(m[2])
  const conn = (await withRateLimitRetry(
    () =>
      client.issues({
        filter: { team: { key: { eq: teamKey } }, number: { eq: number } },
        first: 1,
      } as unknown as Parameters<LinearClient['issues']>[0]),
    retryOpts,
  )) as unknown as SdkIssueConnection
  const node = conn.nodes[0]
  if (!node) {
    throw new LinearAgentError({
      code: 'ISSUE_NOT_FOUND',
      message: `issue not found: ${ref}`,
      details: { ref },
    })
  }
  return node.id
}

// -----------------------------------------------------------------------------
// Lazy-property hydration -- comments expose user, issue, parent as lazy
// promise getters. Hydrate ONLY when the projection spec needs them.
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['user', 'issue', 'parent'])

async function hydrateForProjection(
  comment: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  const hydrated: Record<string, unknown> = { ...comment }

  if (needs.has('user') && hydrated.user !== undefined) {
    hydrated.user = await resolveLazy(hydrated.user)
  }
  if (needs.has('issue') && hydrated.issue !== undefined) {
    hydrated.issue = await resolveLazy(hydrated.issue)
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
