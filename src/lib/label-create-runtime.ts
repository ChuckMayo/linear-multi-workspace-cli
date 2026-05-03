/**
 * `label create` runtime -- Phase 2 PLAN 02-09 Task 2, LBL-01.create.
 *
 * Write command -- the only write in plan 02-09. Creates a Linear issue
 * label scoped to a team. RESEARCH § Pitfall 13: every label gets a
 * `teamId` (workspace-wide labels are an anti-pattern in Linear's data
 * model), so `--team` is REQUIRED.
 *
 * Pre-SDK gates (BEFORE any SDK call):
 *   1. requireExplicitWorkspaceForWrite (WSP-06).
 *   2. Required-flag validation (--name, --team) -> USAGE_ERROR exit 2.
 *
 * Then resolve `--team` to a UUID. Linear's `IssueLabelCreateInput.teamId`
 * requires a UUID, so non-UUID input (key or name) needs a one-shot lookup
 * via `client.teams({ filter, first: 1 })`. UUID input passes through.
 *
 * Error envelopes:
 *   - WORKSPACE_REQUIRED_FOR_WRITE (exit 10) -- write-guard.
 *   - USAGE_ERROR (exit 2) -- missing --name or --team.
 *   - TEAM_NOT_FOUND (exit 13) -- team lookup miss.
 *   - LINEAR_API_ERROR (exit 13) -- payload.success === false.
 *   - RATELIMITED / NETWORK_ERROR / AUTH_INVALID -- via transport classifier.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'
import { FULL_PRESET, type ProjectionSpec, parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'
import { TEAM_KEY_RE, UUID_RE } from '@/lib/filter-heuristics.js'

/** Reserved for future positional args. */
export type LabelCreateArgs = Record<string, never>

export interface LabelCreateFlags {
  workspace?: string
  fields?: string
  /** Per-invocation WSP-06 opt-in. */
  allowActiveWorkspaceWrite?: boolean
  /** Required: label name. */
  name?: string
  /** Required: team UUID, key, or name. */
  team?: string
  /** Optional: label color (hex, e.g. #ff0000). */
  color?: string
  /** Optional: label description. */
  description?: string
}

export interface LabelCreateInput {
  args: LabelCreateArgs
  flags: LabelCreateFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface LabelCreateOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface CreateIssueLabelPayload {
  success: boolean
  lastSyncId: number
  issueLabel?: Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

interface SdkTeamConnection {
  nodes: Array<{ id: string }>
}

export async function labelCreateRuntime(input: LabelCreateInput): Promise<LabelCreateOutput> {
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

  // WSP-06 gate -- BEFORE required-flag validation, factory, or any SDK call.
  requireExplicitWorkspaceForWrite(resolved, input.flags.allowActiveWorkspaceWrite ?? false)

  // Required-flag validation -- BEFORE any SDK call.
  if (input.flags.name === undefined || input.flags.name === '') {
    throw LinearAgentError.usage('--name is required')
  }
  if (input.flags.team === undefined || input.flags.team === '') {
    throw LinearAgentError.usage('--team is required')
  }
  const name: string = input.flags.name
  const teamRef: string = input.flags.team

  const fields = parseFields(input.flags.fields ?? 'defaults', 'label')
  const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

  return withFetchInterception(async () => {
    // Resolve team -> UUID. UUID short-circuits; key/name uses one-shot
    // client.teams filter.
    let teamId: string
    if (UUID_RE.test(teamRef)) {
      teamId = teamRef
    } else {
      const filter = TEAM_KEY_RE.test(teamRef)
        ? { key: { eq: teamRef.toUpperCase() } }
        : { name: { eq: teamRef } }
      const conn = (await withRateLimitRetry(
        () => client.teams({ filter, first: 1 } as unknown as Parameters<LinearClient['teams']>[0]),
        input.retryOptsOverride,
      )) as unknown as SdkTeamConnection
      const team = conn.nodes[0]
      if (!team) {
        throw new LinearAgentError({
          code: 'TEAM_NOT_FOUND',
          message: `team not found: ${teamRef}`,
          details: { ref: teamRef },
        })
      }
      teamId = team.id
    }

    const createInput: Record<string, unknown> = { name, teamId }
    if (input.flags.color !== undefined) createInput.color = input.flags.color
    if (input.flags.description !== undefined) createInput.description = input.flags.description

    const payload = (await withRateLimitRetry(
      () =>
        client.createIssueLabel(
          createInput as unknown as Parameters<LinearClient['createIssueLabel']>[0],
        ),
      input.retryOptsOverride,
    )) as unknown as CreateIssueLabelPayload

    if (!payload.success) {
      throw LinearAgentError.linear.apiError({
        message: 'createIssueLabel returned success=false',
        details: { lastSyncId: payload.lastSyncId },
      })
    }

    let created: Record<string, unknown> | undefined
    if (payload.issueLabel !== undefined) {
      const c = await Promise.resolve(payload.issueLabel)
      if (c !== undefined && c !== null) created = c as Record<string, unknown>
    }
    let data: unknown
    if (created) {
      const hydrated = await hydrateForProjection(created, fields)
      data = project(hydrated, fields)
    } else {
      data = {}
    }

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
// Lazy-property hydration (mirrors label-list-runtime).
// -----------------------------------------------------------------------------

const RELATION_KEYS = new Set(['team', 'parent', 'creator'])

async function hydrateForProjection(
  label: Record<string, unknown>,
  spec: ProjectionSpec,
): Promise<Record<string, unknown>> {
  const needs = neededRelations(spec)
  if (needs.size === 0) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(label)) {
      if (!RELATION_KEYS.has(k)) out[k] = label[k]
    }
    return out
  }
  const hydrated: Record<string, unknown> = {}
  for (const k of Object.keys(label)) {
    if (RELATION_KEYS.has(k)) {
      if (needs.has(k)) {
        const value = label[k]
        hydrated[k] = await resolveLazy(value)
      }
    } else {
      hydrated[k] = label[k]
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
