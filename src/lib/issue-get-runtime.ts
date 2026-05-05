/**
 * `issue get` runtime — Phase 2 PLAN 02-03 Task 1, ISS-02.
 *
 * Single-entity read: accepts EITHER a Linear identifier (`ENG-123`) OR a
 * UUID. Identifier shape is `^[A-Z][A-Z0-9]+-\d+$` (case-insensitive; the team
 * key is uppercased before the SDK call). The two paths route to different
 * SDK methods because `client.issue(id)` only accepts UUIDs:
 *
 *   - identifier → `client.issues({ filter: { team: { key: { eq: KEY } },
 *                                              number: { eq: N } }, first: 1 })`
 *                  then `nodes[0]`
 *   - UUID       → `client.issue(uuid)`
 *
 * Both routes wrap the SDK call in `withRateLimitRetry` inside
 * `withFetchInterception`. The runtime mirrors the 9-step pipeline of
 * `issueListRuntime` (Phase 1 / Plan 02-01) but trims pagination and uses a
 * single hydration call instead of a Promise.all over connection nodes.
 *
 * Hydration: relations (state, assignee, team, project, cycle, parent) are
 * awaited only when the projection spec references them; `--fields=ids`
 * skips relation hydration entirely.
 *
 * Errors:
 *   - Empty identifier result OR `client.issue` returning undefined → throw
 *     `LinearAgentError({ code: 'ISSUE_NOT_FOUND', details: { ref } })`. Exit
 *     13 per the Phase 2 taxonomy extension (Plan 02-01 added the code).
 *   - Rate-limit / network / auth errors are classified by the transport
 *     wrapper into the canonical taxonomy.
 *
 * Single-entity reads do NOT include `pageInfo` in `meta` (no connection).
 */

import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { redact } from '@/core/redact/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { ISSUE_IDENTIFIER_RE } from '@/lib/filter-heuristics.js'
import { validateAndMergeIncludes } from '@/lib/include-fragments.js'

export interface IssueGetArgs {
  /** Issue identifier (`ENG-123`) or UUID. Required. */
  identifier: string
}

export interface IssueGetFlags {
  workspace?: string
  fields?: string
  /** Phase 3: hydrate related entities in a single rawRequest round-trip */
  include?: string[]
}

export interface IssueGetInput {
  args: IssueGetArgs
  flags: IssueGetFlags
  env: NodeJS.ProcessEnv
  /** Test-only seam — defaults to `loadConfig()`. */
  loadConfigOverride?: () => Config
  /** Test-only seam — defaults to `createLinearClient`. */
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  /** Test-only seam — passes through to `withRateLimitRetry`. */
  retryOptsOverride?: RetryOpts
}

export interface IssueGetOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

/** Filter shape for the identifier-resolution branch. */
interface IssueIdentifierFilter {
  team: { key: { eq: string } }
  number: { eq: number }
}

interface SdkIssueConnection {
  nodes: Array<Record<string, unknown>>
}

export async function issueGetRuntime(input: IssueGetInput): Promise<IssueGetOutput> {
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
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  // Phase 3: branch on --include. Empty → unchanged Phase 2 typed-SDK call.
  const includes = input.flags.include ?? []
  if (includes.length === 0) {
    // PHASE 2 BEHAVIOR — UNCHANGED
    return withFetchInterception(async () => {
      const ref = input.args.identifier
      const issue = await resolveIssue(client, ref, input.retryOptsOverride)
      if (!issue) {
        throw new LinearAgentError({
          code: 'ISSUE_NOT_FOUND',
          message: `issue not found: ${ref}`,
          details: { ref },
        })
      }

      const hydrated = await hydrateForProjection(issue, fields)
      const data = project(hydrated, fields)

      const complexity = getLastComplexity()
      const meta: Omit<Meta, 'command'> = {
        workspace: resolved.name,
        workspaceSource: resolved.source,
        ...(complexity !== undefined ? { complexity } : {}),
      }

      return { data, meta }
    })
  }

  // PHASE 3 INCLUDE PATH — single rawRequest with inlined fragments
  const fragmentText = validateAndMergeIncludes('issue get', includes)
  const query = composeIssueGetWithIncludes(fragmentText)

  return withFetchInterception(async () => {
    const ref = input.args.identifier
    const response = (await withRateLimitRetry(
      () =>
        (
          client as unknown as {
            client: {
              rawRequest: (q: string, v: unknown) => Promise<{ data?: unknown; error?: string }>
            }
          }
        ).client.rawRequest(query, { id: ref }),
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
        details: { command: 'issue get', cause: safeCause },
      })
    }

    const issueData = (response.data as { issue?: Record<string, unknown> }).issue
    if (!issueData) {
      throw new LinearAgentError({
        code: 'ISSUE_NOT_FOUND',
        message: `issue not found: ${ref}`,
        details: { ref },
      })
    }

    const data = project(issueData, fields)

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data, meta }
  })
}

async function resolveIssue(
  client: LinearClient,
  ref: string,
  retryOpts?: RetryOpts,
): Promise<Record<string, unknown> | undefined> {
  const m = ISSUE_IDENTIFIER_RE.exec(ref)
  if (m) {
    const teamKey = (m[1] as string).toUpperCase()
    const number = Number(m[2])
    const filter: IssueIdentifierFilter = {
      team: { key: { eq: teamKey } },
      number: { eq: number },
    }
    const conn = (await withRateLimitRetry(
      () =>
        client.issues({
          filter,
          first: 1,
        } as unknown as Parameters<LinearClient['issues']>[0]),
      retryOpts,
    )) as unknown as SdkIssueConnection
    return conn.nodes[0]
  }
  // UUID path — `client.issue(id)` accepts UUID only.
  const issue = (await withRateLimitRetry(() => client.issue(ref), retryOpts)) as unknown as
    | Record<string, unknown>
    | null
    | undefined
  return issue ?? undefined
}

// -----------------------------------------------------------------------------
// Lazy-property hydration (mirrors `issue-list-runtime.ts` for single-entity).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['state', 'assignee', 'team', 'project', 'cycle', 'parent'])

async function hydrateForProjection(
  issue: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    // No relations needed — copy non-relation keys only so we don't accidentally
    // trigger a relation getter via spread enumeration on `--fields=ids`.
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(issue)) {
      if (!RELATION_KEYS.has(k)) out[k] = issue[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(issue)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = issue[k]
        hydrated[k] = await resolveLazy(value)
      }
      // else: skip — don't read the lazy getter at all
    } else {
      hydrated[k] = issue[k]
    }
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

// -----------------------------------------------------------------------------
// Phase 3: compose query for --include path (Approach A — single rawRequest)
// -----------------------------------------------------------------------------

function composeIssueGetWithIncludes(fragmentText: string): string {
  // BL-03 fix: widen the scalar set to match the issue ALLOWED_FIELDS
  // registry (src/core/projection/project.ts). Without this, the
  // --include branch silently returned a strict subset of --fields=full
  // (priorityLabel, estimate, sortOrder, dueDate, etc. were missing).
  return `
    query IssueWithIncludes($id: String!) {
      issue(id: $id) {
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
    }
  `.trim()
}
