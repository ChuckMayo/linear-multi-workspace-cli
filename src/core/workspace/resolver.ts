import { LinearAgentError } from '../errors/index.js'
import type { ResolvedWorkspace, ResolveInput, WorkspaceSource } from './types.js'

/**
 * Pure resolver that translates `(flags, env, config)` into a single
 * `ResolvedWorkspace`. Implements the 6-step precedence chain from
 * `01-CONTEXT.md § Workspace Resolution Precedence`:
 *
 *   1. `flags.workspace`          (--workspace flag)
 *   2. `env.LINEAR_WORKSPACE`     (LINEAR_WORKSPACE env var)
 *   3. `config.active`            (active default in config)
 *   4. single-workspace short-circuit (only one entry in config.workspaces)
 *   5. `env.LINEAR_API_KEY`       (env-key bypass — no config consulted)
 *   6. throw `WORKSPACE_NOT_RESOLVED` (no input matched)
 *
 * Steps 1–3 also throw `WORKSPACE_NOT_FOUND` when the requested name is not
 * registered. This is critical for tenancy isolation (PITFALLS § Pitfall 2):
 * `--workspace ghost` MUST fail loudly rather than silently fall through to
 * the active default.
 *
 * Purity guarantees:
 *   - No `process.env` reads (caller passes `env`)
 *   - No filesystem I/O (caller passes `config`)
 *   - No mutation of any input field (read-only walk)
 *   - Same input -> deeply-equal output, every time
 */
export function resolveWorkspace(input: ResolveInput): ResolvedWorkspace {
  const { flags, env, config } = input

  // Step 1: --workspace flag
  if (flags.workspace) {
    return loadOrThrow(config, flags.workspace, 'flag')
  }

  // Step 2: LINEAR_WORKSPACE env var
  if (env.LINEAR_WORKSPACE) {
    return loadOrThrow(config, env.LINEAR_WORKSPACE, 'env')
  }

  // Step 3: active default in config
  if (config.active) {
    return loadOrThrow(config, config.active, 'active')
  }

  // Step 4: single-workspace short-circuit
  const names = Object.keys(config.workspaces)
  if (names.length === 1) {
    const sole = names[0]
    // Type narrowing: names.length === 1 guarantees names[0] is defined.
    if (sole !== undefined) {
      return loadOrThrow(config, sole, 'single')
    }
  }

  // Step 5: LINEAR_API_KEY env bypass — only when no config-driven source
  // matched. The token is its own selector; workspace name is null.
  if (env.LINEAR_API_KEY) {
    return {
      name: null,
      token: env.LINEAR_API_KEY,
      organizationId: null,
      source: 'api-key-env',
    }
  }

  // Step 6: nothing matched — error with remediation in details.
  throw new LinearAgentError({
    code: 'WORKSPACE_NOT_RESOLVED',
    message:
      'no workspace selected: pass --workspace <name>, set LINEAR_WORKSPACE, or run `linmux workspace use <name>`',
    details: {
      configuredWorkspaces: names,
      remediation:
        names.length === 0
          ? 'run `linmux workspace add <name> --token <api-key>` to register a workspace'
          : 'run `linmux workspace use <name>` to set an active default, or pass --workspace <name>',
    },
  })
}

function loadOrThrow(
  config: ResolveInput['config'],
  name: string,
  source: Exclude<WorkspaceSource, 'api-key-env'>,
): ResolvedWorkspace {
  const entry = config.workspaces[name]
  if (!entry) {
    throw new LinearAgentError({
      code: 'WORKSPACE_NOT_FOUND',
      message: `workspace not found: ${name}`,
      details: {
        requested: name,
        configured: Object.keys(config.workspaces),
        source,
      },
    })
  }
  return {
    name: entry.name,
    token: entry.token,
    organizationId: entry.organizationId,
    source,
  }
}
