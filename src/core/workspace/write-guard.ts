import { LinearAgentError } from '../errors/index.js'
import type { ResolvedWorkspace } from './types.js'

/**
 * WSP-06 enforcement for write commands (mutations).
 *
 * A write command requires an *explicit* workspace selector to prevent
 * cross-workspace data leakage (PITFALLS § Pitfall 2 — the #1 tenancy risk).
 * Of the five `WorkspaceSource` values, three are considered explicit:
 *
 *   - `flag`        — caller passed `--workspace <name>` for THIS invocation
 *   - `env`         — caller set `LINEAR_WORKSPACE` in the env for THIS invocation
 *   - `api-key-env` — `LINEAR_API_KEY` is the selector itself; there is no
 *                     ambiguity about which workspace the token targets, and
 *                     setting it is an explicit per-invocation act
 *
 * The other two are NOT explicit:
 *
 *   - `active` — silently inherits the user's persisted active default
 *   - `single` — auto-picks the only registered workspace (still implicit)
 *
 * For `active` and `single`, this guard throws `WORKSPACE_REQUIRED_FOR_WRITE`
 * BEFORE any SDK call is made — unless the caller passes
 * `allowActiveOptIn=true` (mapped from the per-invocation
 * `--allow-active-workspace-write` flag).
 *
 * The opt-in is per-invocation only. There is no persisted config flag that
 * relaxes this rule globally.
 */
export function requireExplicitWorkspaceForWrite(
  resolved: ResolvedWorkspace,
  allowActiveOptIn: boolean,
): void {
  if (allowActiveOptIn) return
  if (
    resolved.source === 'flag' ||
    resolved.source === 'env' ||
    resolved.source === 'api-key-env'
  ) {
    return
  }
  // 'active' or 'single' — refuse before any network call.
  throw new LinearAgentError({
    code: 'WORKSPACE_REQUIRED_FOR_WRITE',
    message:
      'write commands require an explicit workspace selector: pass --workspace <name>, set LINEAR_WORKSPACE, or pass --allow-active-workspace-write to opt in to using the active default for this invocation',
    details: {
      resolvedWorkspace: resolved.name,
      resolvedFrom: resolved.source,
      remediation:
        'pass --workspace <name>, set LINEAR_WORKSPACE=<name>, or pass --allow-active-workspace-write',
    },
  })
}
