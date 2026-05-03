/**
 * `cycle current` runtime -- Phase 2 PLAN 02-08 Task 1, CYC-01.current.
 *
 * Single-entity read. Fetches the active cycle for a specific team. The
 * `--team` flag is REQUIRED -- without it, throws WORKFLOW_TEAM_REQUIRED
 * (exit 2) BEFORE any SDK call (CONTEXT § Specifics line 117).
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. Validate --team is present (else WORKFLOW_TEAM_REQUIRED, BEFORE SDK).
 *   3. parseFields(input, 'cycle')
 *   4. resolveTeamId(client, ws, ref) -> teamId.
 *   5. client.team(teamId) -> team object.
 *   6. team.cycles({ filter: { isActive: { eq: true } }, first: 1 }).
 *   7. If 0 nodes -> CYCLE_NOT_FOUND with details.teamId + requested:'current'.
 *   8. project + meta. NO pageInfo (single entity).
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 *
 * There is no `client.currentCycle()` SDK helper -- the active cycle for a
 * team is resolved via `team.cycles({ filter: { isActive: { eq: true } } })`
 * per RESEARCH lines 933-957.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import { resolveTeamId } from '@/core/resolvers/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'

export interface CycleCurrentFlags {
  workspace?: string
  fields?: string
  /** REQUIRED -- runtime throws WORKFLOW_TEAM_REQUIRED if absent. */
  team?: string
}

export interface CycleCurrentInput {
  flags: CycleCurrentFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface CycleCurrentOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface CycleConn {
  nodes: Array<Record<string, unknown>>
}

interface SdkTeam {
  cycles: (args: unknown) => Promise<CycleConn>
}

export async function cycleCurrentRuntime(input: CycleCurrentInput): Promise<CycleCurrentOutput> {
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

  // WORKFLOW_TEAM_REQUIRED gate -- runs BEFORE any SDK call.
  if (input.flags.team === undefined || input.flags.team === '') {
    throw new LinearAgentError({
      code: 'WORKFLOW_TEAM_REQUIRED',
      message: 'cycle current requires --team <key|id|name>',
    })
  }

  const fields = parseFields(input.flags.fields ?? 'defaults', 'cycle')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    const workspaceKey = resolved.name ?? '_api-key-env_'
    const teamRef: string = input.flags.team as string

    const teamId = await resolveTeamId(client, workspaceKey, teamRef, input.retryOptsOverride)

    const team = (await withRateLimitRetry(
      () => client.team(teamId),
      input.retryOptsOverride,
    )) as unknown as SdkTeam

    const conn = (await withRateLimitRetry(
      () => team.cycles({ filter: { isActive: { eq: true } }, first: 1 }),
      input.retryOptsOverride,
    )) as unknown as CycleConn

    const current = conn.nodes[0]
    if (!current) {
      throw new LinearAgentError({
        code: 'CYCLE_NOT_FOUND',
        message: `no active cycle for team ${teamRef}`,
        details: { teamId, requested: 'current' },
      })
    }

    const hydrated = await hydrateForProjection(current, fields)
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

// -----------------------------------------------------------------------------
// Lazy-property hydration -- mirrors cycle-list-runtime.
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['team'])

async function hydrateForProjection(
  cycle: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(cycle)) {
      if (!RELATION_KEYS.has(k)) out[k] = cycle[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(cycle)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = cycle[k]
        hydrated[k] = await resolveLazy(value)
      }
    } else {
      hydrated[k] = cycle[k]
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
