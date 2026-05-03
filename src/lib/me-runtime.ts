/**
 * `me` / `whoami` runtime -- Phase 2 PLAN 02-09 Task 1, WHO-01.
 *
 * Read command. Fetches the resolved viewer (current user) and their
 * organization for the active workspace. Both `me` and `whoami` oclif
 * commands share THIS runtime; they differ ONLY in `meta.command` (`'me'`
 * vs `'whoami'`). `whoami` exists purely for discoverability per CONTEXT
 * § Specifics line 65 (the pretty-alias pattern).
 *
 * RESEARCH § Pitfall 6: BOTH `client.viewer` AND `viewer.organization` are
 * lazy promise getters that fire network calls on access. Each MUST be
 * wrapped in `withRateLimitRetry` so the kernel's retry/classify policy
 * engages on rate-limit, network, and auth errors.
 *
 * Pipeline:
 *   1. resolveWorkspace
 *   2. parseFields(input.flags.fields ?? 'defaults', 'user')
 *   3. withFetchInterception(async () => {
 *        user = await withRateLimitRetry(() => client.viewer)
 *        org  = await withRateLimitRetry(() => user.organization)
 *      })
 *   4. project user via the spec; pass organization through with a fixed
 *      `{ id, name, urlKey }` shape (no separate organization preset --
 *      Claude's discretion per plan body).
 *   5. meta. NO pageInfo (single-entity).
 *
 * NOTE: This is a READ -- NO WSP-06 enforcement.
 */
import type { LinearClient } from '@linear/sdk'
import { createLinearClient } from '@/core/client/index.js'
import { type Config, loadConfig } from '@/core/config/index.js'
import type { Meta } from '@/core/output/index.js'
import { parseFields, project } from '@/core/projection/index.js'
import {
  getLastComplexity,
  type RetryOpts,
  withFetchInterception,
  withRateLimitRetry,
} from '@/core/transport/index.js'
import { type ResolvedWorkspace, resolveWorkspace } from '@/core/workspace/index.js'

export interface MeFlags {
  workspace?: string
  fields?: string
}

export interface MeInput {
  flags: MeFlags
  env: NodeJS.ProcessEnv
  loadConfigOverride?: () => Config
  clientFactoryOverride?: (resolved: ResolvedWorkspace) => LinearClient
  retryOptsOverride?: RetryOpts
}

export interface MeOutput {
  data: unknown
  meta: Omit<Meta, 'command'>
}

interface SdkUser {
  id: string
  name?: string
  email?: string
  displayName?: string
  admin?: boolean
  isMe?: boolean
  active?: boolean
  avatarUrl?: string | null
  organization?: Promise<SdkOrganization> | SdkOrganization
}

interface SdkOrganization {
  id: string
  name?: string
  urlKey?: string
}

export async function meRuntime(input: MeInput): Promise<MeOutput> {
  return withFetchInterception(async () => {
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

    const fields = parseFields(input.flags.fields ?? 'defaults', 'user')
    const client = (input.clientFactoryOverride ?? createLinearClient)(resolved)

    // RESEARCH § Pitfall 6: BOTH viewer and viewer.organization are lazy
    // promise getters that fire network calls; MUST be inside withRateLimitRetry.
    const user = (await withRateLimitRetry(
      () => Promise.resolve(client.viewer),
      input.retryOptsOverride,
    )) as unknown as SdkUser
    const org = (await withRateLimitRetry(
      () => Promise.resolve(user.organization as SdkOrganization | Promise<SdkOrganization>),
      input.retryOptsOverride,
    )) as unknown as SdkOrganization

    const projectedUser = project(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        displayName: user.displayName,
        admin: user.admin,
        isMe: user.isMe,
        active: user.active,
        avatarUrl: user.avatarUrl,
      },
      fields,
    )

    const data = {
      user: projectedUser,
      organization: { id: org.id, name: org.name, urlKey: org.urlKey },
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
