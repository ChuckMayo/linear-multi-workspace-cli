/**
 * `team get <ref>` runtime -- Phase 2 PLAN 02-09 Task 1, TEM-01.get.
 *
 * Single-entity read. Accepts EITHER a UUID, a team key (e.g. `ENG`), OR a
 * team name. Routes:
 *   - UUID  -> `client.team(uuid)` directly (the SDK accepts UUID only)
 *   - KEY   -> `client.teams({ filter: { key: { eq: KEY } }, first: 1 })`
 *   - name  -> `client.teams({ filter: { name: { eq: name } }, first: 1 })`
 *
 * Shape detection via `UUID_RE` and `TEAM_KEY_RE` from filter-heuristics
 * (Plan 02-01) -- no resolver dependency.
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input, 'team')
 *   3. UUID? key? name? -> appropriate SDK call
 *   4. project + meta. NO pageInfo (single entity).
 *
 * Errors:
 *   - TEAM_NOT_FOUND (exit 13) -- UUID returned undefined OR filter returned 0 nodes.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { TEAM_KEY_RE, UUID_RE } from '@/lib/filter-heuristics.js'

export interface TeamGetArgs {
  /** Team UUID, key (e.g. `ENG`), or name. Required. */
  ref: string
}

export interface TeamGetFlags {
  workspace?: string
  fields?: string
}

export interface TeamGetInput {
  args: TeamGetArgs
  flags: TeamGetFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface TeamGetOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface SdkTeamConnection {
  nodes: Array<Record<string, unknown>>
}

export async function teamGetRuntime(input: TeamGetInput): Promise<TeamGetOutput> {
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

  const fields = parseFields(input.flags.fields ?? 'defaults', 'team')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const ref = input.args.ref
    let team: Record<string, unknown> | null | undefined

    if (UUID_RE.test(ref)) {
      team = (await withRateLimitRetry(
        () => client.team(ref),
        input.retryOptsOverride,
      )) as unknown as Record<string, unknown> | null | undefined
    } else if (TEAM_KEY_RE.test(ref)) {
      const conn = (await withRateLimitRetry(
        () =>
          client.teams({
            filter: { key: { eq: ref.toUpperCase() } },
            first: 1,
          } as unknown as Parameters<LinearClient['teams']>[0]),
        input.retryOptsOverride,
      )) as unknown as SdkTeamConnection
      team = conn.nodes[0]
    } else {
      const conn = (await withRateLimitRetry(
        () =>
          client.teams({
            filter: { name: { eq: ref } },
            first: 1,
          } as unknown as Parameters<LinearClient['teams']>[0]),
        input.retryOptsOverride,
      )) as unknown as SdkTeamConnection
      team = conn.nodes[0]
    }

    if (!team) {
      throw new LinearAgentError({
        code: 'TEAM_NOT_FOUND',
        message: `team not found: ${ref}`,
        details: { ref },
      })
    }

    const data = project(team, fields)

    const complexity = getLastComplexity()
    const meta: Omit<Meta, 'command'> = {
      workspace: resolved.name,
      workspaceSource: resolved.source,
      ...(complexity !== undefined ? { complexity } : {}),
    }

    return { data, meta }
  })
}
