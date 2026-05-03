/**
 * `team list` runtime -- Phase 2 PLAN 02-09 Task 1, TEM-01.list.
 *
 * Read command. Lists workspace-scoped teams via `client.teams({ first, after })`.
 * Wraps the SDK call in `withRateLimitRetry` inside `withFetchInterception`.
 * Uses `parseFields(input, 'team')` for projection, with the 02-01 default
 * preset (8 fields including `key`, `name`, `description`, `color`, `private`,
 * `cycleEnabled`).
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'team')
 *   3. parsePagination -> { first, after }
 *   4. withFetchInterception(async () => withRateLimitRetry(client.teams(...)))
 *   5. project + meta with pageInfo, opt-in complexity.
 *
 * No lazy hydration is needed -- TEAM_PRESETS.defaults is entirely top-level
 * scalars (no relation paths like `team.someRelation.x`).
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement. Reads are allowed against
 * the active default workspace.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import type { Meta } from '@/core/output/index.js'
import { parsePagination } from '@/core/pagination/index.js'
import { parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'

export interface TeamListFlags {
  workspace?: string
  fields?: string
  limit?: number
  cursor?: string
}

export interface TeamListInput {
  flags: TeamListFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface TeamListOutput {
  data: unknown[]
  meta: Omit<Meta, 'command'>
}

interface SdkTeamConnection {
  nodes: Array<Record<string, unknown>>
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

export async function teamListRuntime(input: TeamListInput): Promise<TeamListOutput> {
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
  const { first, after } = parsePagination({
    ...(input.flags.limit !== undefined ? { limit: input.flags.limit } : {}),
    ...(input.flags.cursor !== undefined ? { cursor: input.flags.cursor } : {}),
  })

  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const teamsArgs: { first: number; after?: string } = { first }
    if (after !== undefined) teamsArgs.after = after

    const connection = (await withRateLimitRetry(
      () => client.teams(teamsArgs as unknown as Parameters<LinearClient['teams']>[0]),
      input.retryOptsOverride,
    )) as unknown as SdkTeamConnection

    const projected = connection.nodes.map((node) => project(node, fields))

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
