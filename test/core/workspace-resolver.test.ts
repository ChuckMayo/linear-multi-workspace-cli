import { describe, expect, it } from 'vitest'

import { LinearAgentError } from '@/core/errors/index.js'
import { resolveWorkspace } from '@/core/workspace/resolver.js'
import type { ResolveInput } from '@/core/workspace/types.js'

/**
 * Test fixtures for resolveWorkspace.
 *
 * All inputs are constructed as `ResolveInput` literals so the resolver is
 * exercised purely (no I/O, no env mocking, no filesystem). The caller in
 * production is responsible for reading `process.env` and the loaded config
 * — the resolver itself only consumes the structural input.
 */

const ACME_ENTRY = {
  name: 'acme',
  token: 'lin_api_acme_token',
  organizationId: 'org-acme-uuid',
}

const BETA_ENTRY = {
  name: 'beta',
  token: 'lin_api_beta_token',
  organizationId: 'org-beta-uuid',
}

const EMPTY_INPUT: ResolveInput = {
  flags: {},
  env: {},
  config: { active: null, workspaces: {} },
}

function withConfig(workspaces: Record<string, typeof ACME_ENTRY>, active: string | null = null): ResolveInput['config'] {
  return { active, workspaces }
}

describe('resolveWorkspace — precedence chain', () => {
  it('Test 1: --workspace flag wins (source: flag)', () => {
    const result = resolveWorkspace({
      flags: { workspace: 'acme' },
      env: {},
      config: withConfig({ acme: ACME_ENTRY }),
    })
    expect(result).toEqual({
      name: 'acme',
      token: 'lin_api_acme_token',
      organizationId: 'org-acme-uuid',
      source: 'flag',
    })
  })

  it('Test 2: LINEAR_WORKSPACE env wins when no flag (source: env)', () => {
    const result = resolveWorkspace({
      flags: {},
      env: { LINEAR_WORKSPACE: 'acme' },
      config: withConfig({ acme: ACME_ENTRY }),
    })
    expect(result).toEqual({
      name: 'acme',
      token: 'lin_api_acme_token',
      organizationId: 'org-acme-uuid',
      source: 'env',
    })
  })

  it('Test 3: active default when no flag/env (source: active)', () => {
    const result = resolveWorkspace({
      flags: {},
      env: {},
      config: withConfig({ acme: ACME_ENTRY, beta: BETA_ENTRY }, 'acme'),
    })
    expect(result).toEqual({
      name: 'acme',
      token: 'lin_api_acme_token',
      organizationId: 'org-acme-uuid',
      source: 'active',
    })
  })

  it('Test 4: single-workspace short-circuit when active is null (source: single)', () => {
    const result = resolveWorkspace({
      flags: {},
      env: {},
      config: withConfig({ beta: BETA_ENTRY }, null),
    })
    expect(result).toEqual({
      name: 'beta',
      token: 'lin_api_beta_token',
      organizationId: 'org-beta-uuid',
      source: 'single',
    })
  })

  it('Test 5: LINEAR_API_KEY bypass when config empty (source: api-key-env)', () => {
    const result = resolveWorkspace({
      flags: {},
      env: { LINEAR_API_KEY: 'lin_api_envkey' },
      config: withConfig({}, null),
    })
    expect(result).toEqual({
      name: null,
      token: 'lin_api_envkey',
      organizationId: null,
      source: 'api-key-env',
    })
  })
})

describe('resolveWorkspace — error branches', () => {
  it('Test 6a: --workspace ghost (not registered) throws WORKSPACE_NOT_FOUND', () => {
    expect(() =>
      resolveWorkspace({
        flags: { workspace: 'ghost' },
        env: {},
        config: withConfig({ acme: ACME_ENTRY }),
      }),
    ).toThrow(LinearAgentError)

    try {
      resolveWorkspace({
        flags: { workspace: 'ghost' },
        env: {},
        config: withConfig({ acme: ACME_ENTRY }),
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_NOT_FOUND')
      expect(err.details).toMatchObject({ requested: 'ghost', source: 'flag' })
    }
  })

  it('Test 6b: LINEAR_WORKSPACE=ghost (not registered) throws WORKSPACE_NOT_FOUND', () => {
    try {
      resolveWorkspace({
        flags: {},
        env: { LINEAR_WORKSPACE: 'ghost' },
        config: withConfig({ acme: ACME_ENTRY }),
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_NOT_FOUND')
      expect(err.details).toMatchObject({ requested: 'ghost', source: 'env' })
    }
  })

  it('Test 6c: config.active references unregistered workspace throws WORKSPACE_NOT_FOUND', () => {
    try {
      resolveWorkspace({
        flags: {},
        env: {},
        // Note: bypasses ConfigSchema.refine() — defensive at resolver layer.
        config: { active: 'ghost', workspaces: { acme: ACME_ENTRY } },
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_NOT_FOUND')
      expect(err.details).toMatchObject({ requested: 'ghost', source: 'active' })
    }
  })

  it('Test 6d: 2+ workspaces, no flag/env/active, no LINEAR_API_KEY -> WORKSPACE_NOT_RESOLVED', () => {
    try {
      resolveWorkspace({
        flags: {},
        env: {},
        config: withConfig({ acme: ACME_ENTRY, beta: BETA_ENTRY }, null),
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_NOT_RESOLVED')
      // Remediation should be present and reference workspace use / --workspace
      expect(err.details).toBeDefined()
      const details = err.details as { configuredWorkspaces?: string[]; remediation?: string }
      expect(details.configuredWorkspaces).toEqual(['acme', 'beta'])
      expect(details.remediation).toMatch(/workspace use|--workspace/)
    }
  })

  it('Test 6e: empty config and no LINEAR_API_KEY -> WORKSPACE_NOT_RESOLVED', () => {
    try {
      resolveWorkspace(EMPTY_INPUT)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_NOT_RESOLVED')
      const details = err.details as { configuredWorkspaces?: string[]; remediation?: string }
      expect(details.configuredWorkspaces).toEqual([])
      expect(details.remediation).toMatch(/workspace add/)
    }
  })
})

describe('resolveWorkspace — interaction tests', () => {
  it('Test 7: --workspace flag wins over LINEAR_API_KEY (step 1 beats step 5)', () => {
    const result = resolveWorkspace({
      flags: { workspace: 'acme' },
      env: { LINEAR_API_KEY: 'lin_api_envkey' },
      config: withConfig({ acme: ACME_ENTRY }),
    })
    expect(result.source).toBe('flag')
    expect(result).toEqual({
      name: 'acme',
      token: 'lin_api_acme_token',
      organizationId: 'org-acme-uuid',
      source: 'flag',
    })
  })

  it('Test 8: LINEAR_WORKSPACE env wins over LINEAR_API_KEY (step 2 beats step 5)', () => {
    const result = resolveWorkspace({
      flags: {},
      env: { LINEAR_WORKSPACE: 'acme', LINEAR_API_KEY: 'lin_api_envkey' },
      config: withConfig({ acme: ACME_ENTRY }),
    })
    expect(result.source).toBe('env')
    expect(result).toEqual({
      name: 'acme',
      token: 'lin_api_acme_token',
      organizationId: 'org-acme-uuid',
      source: 'env',
    })
  })

  it('Test 9: resolveWorkspace is pure (idempotent + no input mutation)', () => {
    const input: ResolveInput = {
      flags: { workspace: 'acme' },
      env: {},
      config: withConfig({ acme: ACME_ENTRY, beta: BETA_ENTRY }, 'beta'),
    }
    const beforeJson = JSON.stringify(input)
    const a = resolveWorkspace(input)
    const b = resolveWorkspace(input)
    const afterJson = JSON.stringify(input)
    expect(a).toEqual(b)
    expect(beforeJson).toBe(afterJson)
  })

  it('Test 10: returns the right token (no cross-contamination between workspaces)', () => {
    const result = resolveWorkspace({
      flags: { workspace: 'beta' },
      env: {},
      config: withConfig({ acme: ACME_ENTRY, beta: BETA_ENTRY }, 'acme'),
    })
    // Picked beta even though acme is active and listed first in workspaces
    expect(result).toEqual({
      name: 'beta',
      token: 'lin_api_beta_token',
      organizationId: 'org-beta-uuid',
      source: 'flag',
    })
  })
})
