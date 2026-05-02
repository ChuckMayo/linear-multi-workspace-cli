/**
 * Type definitions for the workspace resolver and the LinearClient factory.
 *
 * `ResolvedWorkspace` is the *output* of `resolveWorkspace()` — it represents
 * "which workspace is this CLI invocation operating against, and how was it
 * selected?" Every command in PLAN-04 and PLAN-05 reads this shape.
 *
 * `WorkspaceSource` is the discriminator. The five values map 1:1 with the
 * precedence chain documented in `01-CONTEXT.md § Workspace Resolution
 * Precedence`:
 *
 *   1. `flag`         — caller passed `--workspace <name>`
 *   2. `env`          — `LINEAR_WORKSPACE` env var
 *   3. `active`       — config's `active` default
 *   4. `single`       — exactly one workspace registered (auto-pick)
 *   5. `api-key-env`  — only `LINEAR_API_KEY` set; bypass config entirely
 *
 * `ResolveInput.config` is intentionally a structural subset of the full
 * `Config` type from `src/core/config/schema.ts`. This module does NOT
 * import from `src/core/config/` so the resolver remains a pure function
 * over its inputs and can be tested without filesystem mocks.
 */
export type WorkspaceSource = 'flag' | 'env' | 'active' | 'single' | 'api-key-env'

/**
 * Resolved workspace selection. Discriminated by `source`.
 *
 * For all sources except `api-key-env`, the resolved workspace has a name and
 * an organizationId loaded from the config entry. For `api-key-env`, the
 * resolver doesn't know which workspace the env-supplied token targets — the
 * Linear API itself is the source of truth for that — so `name` and
 * `organizationId` are `null` and downstream `meta.workspace` is rendered
 * as `null`.
 */
export type ResolvedWorkspace =
  | {
      name: string
      token: string
      organizationId: string
      source: Exclude<WorkspaceSource, 'api-key-env'>
    }
  | { name: null; token: string; organizationId: null; source: 'api-key-env' }

/**
 * Input shape for `resolveWorkspace()`.
 *
 * Caller is responsible for:
 *   - Reading argv flags into `flags.workspace`
 *   - Reading `process.env.LINEAR_WORKSPACE` and `LINEAR_API_KEY` into `env`
 *   - Loading config via `loadConfig()` and passing the relevant subset
 *
 * The resolver does NOT touch `process` or the filesystem.
 */
export interface ResolveInput {
  flags: { workspace?: string }
  env: { LINEAR_WORKSPACE?: string; LINEAR_API_KEY?: string }
  config: {
    active: string | null
    workspaces: Record<string, { name: string; token: string; organizationId: string }>
  }
}
