/**
 * Workspace command tests (Phase 1 PLAN-04).
 *
 * Tests run AGAINST the `runCommand` helper and per-command handler logic
 * directly — NOT the oclif binary. This avoids spinning up subprocesses for
 * every test. The smoke test (`test/smoke.test.ts`) covers end-to-end binary
 * invocation against an empty config.
 *
 * SDK mocking: vitest's `vi.mock('@linear/sdk')` provides a stub `LinearClient`
 * whose `.viewer` is a Promise we control per-test via `setMockViewer` / `setMockViewerError`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub @linear/sdk BEFORE importing modules that consume it. Phase 2 PLAN
// 02-01 routes every SDK call through `withRateLimitRetry` whose classifier
// discriminates on `instanceof` of the typed error classes — the mock
// therefore EXPORTS the error class hierarchy (not only `LinearClient`)
// so `import { RatelimitedLinearError } from '@linear/sdk'` in the
// transport resolves to the same class identity tests can `new` and
// throw.
vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    complexityRemaining?: number
    complexityLimit?: number
    complexityResetAt?: number | Date
    constructor(opts?: {
      message?: string
      retryAfter?: number
      complexityRemaining?: number
      complexityLimit?: number
      complexityResetAt?: number | Date
    }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
      if (opts?.complexityRemaining !== undefined)
        this.complexityRemaining = opts.complexityRemaining
      if (opts?.complexityLimit !== undefined) this.complexityLimit = opts.complexityLimit
      if (opts?.complexityResetAt !== undefined) this.complexityResetAt = opts.complexityResetAt
    }
  }
  class NetworkLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'network error')
      this.name = 'NetworkLinearError'
    }
  }
  class AuthenticationLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'auth error')
      this.name = 'AuthenticationLinearError'
    }
  }
  class InvalidInputLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'invalid input')
      this.name = 'InvalidInputLinearError'
    }
  }
  class InternalLinearError extends LinearError {
    constructor(message?: string) {
      super(message ?? 'internal')
      this.name = 'InternalLinearError'
    }
  }
  return {
    LinearError,
    RatelimitedLinearError,
    NetworkLinearError,
    AuthenticationLinearError,
    InvalidInputLinearError,
    InternalLinearError,
    LinearClient: class MockLinearClient {
      apiKey: string
      // store apiKey so tests can inspect which token a viewer call was associated with
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
      }
      get viewer(): Promise<unknown> {
        if (mockViewerError) {
          return Promise.reject(mockViewerError)
        }
        if (mockViewer) {
          return Promise.resolve(mockViewer)
        }
        return Promise.reject(new Error('no mock viewer configured'))
      }
    },
  }
})

let mockViewer: { organization: Promise<{ id: string }> } | null = null
let mockViewerError: Error | null = null

function setMockViewerOrgId(id: string): void {
  mockViewerError = null
  mockViewer = { organization: Promise.resolve({ id }) }
}

function setMockViewerError(err: Error): void {
  mockViewer = null
  mockViewerError = err
}

function clearMockViewer(): void {
  mockViewer = null
  mockViewerError = null
}

import {
  AuthenticationLinearError as RealAuthenticationLinearError,
  RatelimitedLinearError as RealRatelimitedLinearError,
} from '@linear/sdk'
import { runWorkspaceAdd } from '@/commands/workspace/add.js'
import { runWorkspaceList } from '@/commands/workspace/list.js'
import { runWorkspaceRemove } from '@/commands/workspace/remove.js'
import { runWorkspaceReplaceToken } from '@/commands/workspace/replace-token.js'
import { runWorkspaceUse } from '@/commands/workspace/use.js'
import { configPath } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { runCommand } from '@/lib/workspace-runtime.js'

// vi.mock above replaces @linear/sdk with our own classes whose
// constructors accept a single string. Cast away the SDK constructor
// signature for test-side use.
const AuthenticationLinearError = RealAuthenticationLinearError as unknown as new (
  msg?: string,
) => Error
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (opts?: {
  message?: string
  retryAfter?: number
}) => Error

let tmpHome: string
let configFile: string

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'linear-agent-cmd-'))
  process.env.XDG_CONFIG_HOME = tmpHome
  configFile = configPath()
  clearMockViewer()
})

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME
  rmSync(tmpHome, { recursive: true, force: true })
})

// -----------------------------------------------------------------------------
// SECTION 1: Shared command runtime (_shared.ts)
// -----------------------------------------------------------------------------

describe('runCommand (_shared)', () => {
  it('Test 1: success handler produces success envelope on stdout, no stderr, exit 0', async () => {
    const out = await runCommand({
      commandPath: 'workspace add',
      pretty: false,
      handler: async () => ({ data: { foo: 'bar' }, meta: {} }),
    })
    expect(out.exitCode).toBe(0)
    expect(out.stderr).toBeUndefined()
    const env = JSON.parse(out.stdout.trim())
    expect(env.$apiVersion).toBe('1')
    expect(env.ok).toBe(true)
    expect(env.data).toEqual({ foo: 'bar' })
    expect(env.meta.command).toBe('workspace add')
    expect(out.stdout).toMatchSnapshot('shared-success-envelope')
  })

  it('Test 2: LinearAgentError handler produces failure envelope; exit 10 for WORKSPACE_NOT_FOUND', async () => {
    const out = await runCommand({
      commandPath: 'workspace use',
      pretty: false,
      handler: async () => {
        throw new LinearAgentError({ code: 'WORKSPACE_NOT_FOUND', message: 'not found' })
      },
    })
    expect(out.exitCode).toBe(10)
    expect(out.stderr).toBeUndefined()
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('WORKSPACE_NOT_FOUND')
    expect(env.meta.command).toBe('workspace use')

    const pretty = await runCommand({
      commandPath: 'workspace use',
      pretty: true,
      handler: async () => {
        throw new LinearAgentError({ code: 'WORKSPACE_NOT_FOUND', message: 'not found' })
      },
    })
    expect(pretty.stderr).toBeDefined()
    expect(pretty.stderr).toContain('WORKSPACE_NOT_FOUND')
  })

  it('Test 3: unexpected non-LinearAgentError is wrapped as GENERIC_ERROR exit 1', async () => {
    const out = await runCommand({
      commandPath: 'workspace add',
      pretty: false,
      handler: async () => {
        throw new Error('boom')
      },
    })
    expect(out.exitCode).toBe(1)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('GENERIC_ERROR')
    expect(env.error.message).toBe('Internal error')
    expect(env.error.details?.cause).toBe('boom')
  })

  it('Test 4: token-shaped substring in error.message is scrubbed via redact()', async () => {
    const out = await runCommand({
      commandPath: 'workspace add',
      pretty: false,
      handler: async () => {
        // Plain Error (not LinearAgentError) → wrapped as GENERIC_ERROR with details.cause
        throw new Error('Authorization: Bearer lin_api_super_secret_value')
      },
    })
    expect(out.stdout).not.toContain('lin_api_super_secret_value')
    expect(out.stdout).toContain('[REDACTED]')
  })
})

// -----------------------------------------------------------------------------
// SECTION 2: workspace add
// -----------------------------------------------------------------------------

describe('workspace add', () => {
  it('Test 5: happy path — first workspace becomes active; org id captured; token never on stdout', async () => {
    setMockViewerOrgId('org-uuid-acme')

    const out = await runWorkspaceAdd({ name: 'acme', token: 'lin_api_test_xxx', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())

    expect(env.ok).toBe(true)
    expect(env.data.name).toBe('acme')
    expect(env.data.organizationId).toBe('org-uuid-acme')
    expect(env.data.isActive).toBe(true)
    expect(typeof env.data.createdAt).toBe('string')
    expect(env.meta.command).toBe('workspace add')
    expect(env.meta.workspace).toBe('acme')
    // Token must NEVER appear in any unredacted form on stdout.
    expect(out.stdout).not.toMatch(/lin_api_(?!\[REDACTED\])/)

    // Disk: config has acme + active=acme
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.active).toBe('acme')
    expect(onDisk.workspaces.acme.token).toBe('lin_api_test_xxx')
    expect(onDisk.workspaces.acme.organizationId).toBe('org-uuid-acme')
  })

  it('Test 6: subsequent add does NOT change active', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme_token', pretty: false })

    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta_token', pretty: false })

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.active).toBe('acme')
    expect(Object.keys(onDisk.workspaces).sort()).toEqual(['acme', 'beta'])
  })

  it('Test 7: re-adding an existing name throws WORKSPACE_ALREADY_EXISTS (exit 10) with replace-token hint', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme_token', pretty: false })

    // viewer mock left in place; should not even be hit since we error first
    const out = await runWorkspaceAdd({ name: 'acme', token: 'lin_api_other', pretty: false })
    expect(out.exitCode).toBe(10)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('WORKSPACE_ALREADY_EXISTS')
    expect(env.error.message).toMatch(/replace-token/)
  })

  it('Test 8: invalid token (401-shaped error) maps to AUTH_INVALID (exit 11); config NOT modified', async () => {
    // Snapshot config-before
    const before = (() => {
      try {
        return readFileSync(configFile, 'utf8')
      } catch {
        return ''
      }
    })()

    // Phase 2 PLAN 02-01: classifySdkError uses instanceof discrimination.
    setMockViewerError(new AuthenticationLinearError('Invalid API key (HTTP 401)'))

    const out = await runWorkspaceAdd({ name: 'acme', token: 'lin_api_bad', pretty: false })
    expect(out.exitCode).toBe(11)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('AUTH_INVALID')

    // Disk-state unchanged
    const after = (() => {
      try {
        return readFileSync(configFile, 'utf8')
      } catch {
        return ''
      }
    })()
    expect(after).toBe(before)
  })

  it('Test 9: org-id collision attaches data.warning but still succeeds', async () => {
    setMockViewerOrgId('org-uuid-shared')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_one', pretty: false })

    setMockViewerOrgId('org-uuid-shared')
    const out = await runWorkspaceAdd({ name: 'beta', token: 'lin_api_two', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.data.warning).toMatch(/already registered.*acme/)
    expect(env.data.warning).toMatchSnapshot('add-org-collision-warning')
  })

  it('Phase 2 Task 3 Test 12: RatelimitedLinearError surfaces exit 14; retryOptsOverride.maxAttempts=1 disables wait', async () => {
    // Phase 2 PLAN 02-01: workspace add now routes through withRateLimitRetry,
    // so a real RatelimitedLinearError flows through the transport classifier.
    setMockViewerError(new RatelimitedLinearError())
    const out = await runWorkspaceAdd({
      name: 'acme',
      token: 'lin_api_test_xxx',
      pretty: false,
      retryOptsOverride: { maxAttempts: 1 },
    })
    expect(out.exitCode).toBe(14)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('RATELIMITED')
    expect(env.error.transient).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// SECTION 3: workspace list
// -----------------------------------------------------------------------------

describe('workspace list', () => {
  it('Test 10: lists registered workspaces with active flag; tokens NEVER included', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })

    const out = await runWorkspaceList({ pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.meta.command).toBe('workspace list')
    expect(Array.isArray(env.data.workspaces)).toBe(true)
    expect(env.data.workspaces).toHaveLength(2)

    const acme = env.data.workspaces.find((w: { name: string }) => w.name === 'acme')
    const beta = env.data.workspaces.find((w: { name: string }) => w.name === 'beta')
    expect(acme.organizationId).toBe('org-uuid-acme')
    expect(acme.isActive).toBe(true)
    expect(typeof acme.createdAt).toBe('string')
    expect('token' in acme).toBe(false)

    expect(beta.organizationId).toBe('org-uuid-beta')
    expect(beta.isActive).toBe(false)
    expect('token' in beta).toBe(false)

    // Hard guarantee: no raw lin_api_ in stdout.
    expect(out.stdout).not.toMatch(/lin_api_(?!\[REDACTED\])/)
  })

  it('Test 11: empty config returns empty workspaces array', async () => {
    const out = await runWorkspaceList({ pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.data.workspaces).toEqual([])
    expect(env.meta.command).toBe('workspace list')
    expect(out.stdout).toMatchSnapshot('list-empty-config')
  })

  it('Test 12: --pretty produces a compact human-readable table', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })

    const out = await runWorkspaceList({ pretty: true })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('acme')
    expect(out.stdout).toContain('beta')
    expect(out.stdout).not.toMatch(/lin_api_(?!\[REDACTED\])/)
  })
})

// -----------------------------------------------------------------------------
// SECTION 4: workspace use
// -----------------------------------------------------------------------------

describe('workspace use', () => {
  it('Test 13: happy path — sets active and persists', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })

    const out = await runWorkspaceUse({ name: 'beta', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.data.active).toBe('beta')
    expect(env.meta.command).toBe('workspace use')
    expect(env.meta.workspace).toBe('beta')

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.active).toBe('beta')
  })

  it('Test 14: use ghost throws WORKSPACE_NOT_FOUND (exit 10)', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })

    const out = await runWorkspaceUse({ name: 'ghost', pretty: false })
    expect(out.exitCode).toBe(10)
    const env = JSON.parse(out.stdout.trim())
    expect(env.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('Test 15: use is idempotent', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })

    await runWorkspaceUse({ name: 'beta', pretty: false })
    const out = await runWorkspaceUse({ name: 'beta', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.data.active).toBe('beta')
  })
})

// -----------------------------------------------------------------------------
// SECTION 5: workspace remove (TASK 2)
// -----------------------------------------------------------------------------

describe('workspace remove', () => {
  it('Test 16: removing active picks alphabetical-first remaining as new active', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })
    // active=acme (added first)

    const out = await runWorkspaceRemove({ name: 'acme', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.data.removed).toBe('acme')
    expect(env.data.active).toBe('beta')
    expect(env.meta.command).toBe('workspace remove')

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(Object.keys(onDisk.workspaces)).toEqual(['beta'])
    expect(onDisk.active).toBe('beta')
    expect(out.stdout).toMatchSnapshot('remove-active-with-remaining')
  })

  it('Test 17: removing the last workspace clears active to null', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })

    const out = await runWorkspaceRemove({ name: 'acme', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.data.removed).toBe('acme')
    expect(env.data.active).toBe(null)

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.active).toBe(null)
    expect(onDisk.workspaces).toEqual({})
  })

  it('Test 18: removing a non-active workspace leaves active unchanged', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    setMockViewerOrgId('org-uuid-beta')
    await runWorkspaceAdd({ name: 'beta', token: 'lin_api_beta', pretty: false })

    const out = await runWorkspaceRemove({ name: 'beta', pretty: false })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.data.removed).toBe('beta')
    expect(env.data.active).toBe('acme')

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.active).toBe('acme')
    expect(Object.keys(onDisk.workspaces)).toEqual(['acme'])
  })

  it('Test 19: remove ghost throws WORKSPACE_NOT_FOUND (exit 10), config unchanged', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })
    const before = readFileSync(configFile, 'utf8')

    const out = await runWorkspaceRemove({ name: 'ghost', pretty: false })
    expect(out.exitCode).toBe(10)
    const env = JSON.parse(out.stdout.trim())
    expect(env.error.code).toBe('WORKSPACE_NOT_FOUND')

    const after = readFileSync(configFile, 'utf8')
    expect(after).toBe(before)
  })

  it('Test 20: remove never prompts (no interactive confirmation)', async () => {
    // The function is synchronous-shaped (returns Promise<{ stdout, stderr?, exitCode }>),
    // so any "prompt" would have to read stdin. The fact that runWorkspaceRemove
    // resolves without us providing stdin is the assertion. (This is also a code-shape
    // test: we never import readline / inquirer in remove.ts.)
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })

    const promise = runWorkspaceRemove({ name: 'acme', pretty: false })
    const out = await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout — likely waiting on stdin')), 2000),
      ),
    ])
    expect(out.exitCode).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// SECTION 6: workspace replace-token (TASK 2)
// -----------------------------------------------------------------------------

describe('workspace replace-token', () => {
  it('Test 21: happy path — same org id, token swapped, other fields preserved', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_old', pretty: false })

    const before = JSON.parse(readFileSync(configFile, 'utf8'))
    const beforeCreatedAt = before.workspaces.acme.createdAt

    setMockViewerOrgId('org-uuid-acme')
    const out = await runWorkspaceReplaceToken({
      name: 'acme',
      token: 'lin_api_new',
      pretty: false,
    })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout.trim())
    expect(env.ok).toBe(true)
    expect(env.data.name).toBe('acme')
    expect(env.data.organizationId).toBe('org-uuid-acme')
    expect(env.meta.command).toBe('workspace replace-token')
    expect(env.meta.workspace).toBe('acme')

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(onDisk.workspaces.acme.token).toBe('lin_api_new')
    expect(onDisk.workspaces.acme.organizationId).toBe('org-uuid-acme')
    expect(onDisk.workspaces.acme.createdAt).toBe(beforeCreatedAt)
  })

  it('Test 22: token from a different org throws WORKSPACE_TOKEN_MISMATCH (exit 10), config unchanged', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_old', pretty: false })
    const before = readFileSync(configFile, 'utf8')

    setMockViewerOrgId('org-uuid-other')
    const out = await runWorkspaceReplaceToken({
      name: 'acme',
      token: 'lin_api_other_org',
      pretty: false,
    })
    expect(out.exitCode).toBe(10)
    const env = JSON.parse(out.stdout.trim())
    expect(env.error.code).toBe('WORKSPACE_TOKEN_MISMATCH')

    const after = readFileSync(configFile, 'utf8')
    expect(after).toBe(before)
  })

  it('Test 23: replace-token ghost throws WORKSPACE_NOT_FOUND (exit 10)', async () => {
    const out = await runWorkspaceReplaceToken({
      name: 'ghost',
      token: 'lin_api_x',
      pretty: false,
    })
    expect(out.exitCode).toBe(10)
    const env = JSON.parse(out.stdout.trim())
    expect(env.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('Test 24: token rejected by Linear (401-shaped) → AUTH_INVALID (exit 11), config unchanged', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_old', pretty: false })
    const before = readFileSync(configFile, 'utf8')

    // Phase 2 PLAN 02-01: classifySdkError uses instanceof discrimination.
    setMockViewerError(new AuthenticationLinearError('Invalid API key (HTTP 401)'))
    const out = await runWorkspaceReplaceToken({
      name: 'acme',
      token: 'lin_api_bad',
      pretty: false,
    })
    expect(out.exitCode).toBe(11)
    const env = JSON.parse(out.stdout.trim())
    expect(env.error.code).toBe('AUTH_INVALID')

    const after = readFileSync(configFile, 'utf8')
    expect(after).toBe(before)
  })

  it('Test 25: success envelope NEVER includes the new token', async () => {
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_old', pretty: false })

    setMockViewerOrgId('org-uuid-acme')
    const out = await runWorkspaceReplaceToken({
      name: 'acme',
      token: 'lin_api_brand_new_secret',
      pretty: false,
    })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).not.toContain('lin_api_brand_new_secret')
    expect(out.stdout).not.toMatch(/lin_api_(?!\[REDACTED\])/)
    expect(out.stdout).toMatchSnapshot('replace-token-success')
  })
})

// -----------------------------------------------------------------------------
// SECTION 7: Config file 0600 mode preserved across command writes
// -----------------------------------------------------------------------------

describe('command writes preserve 0600 mode (sanity check on config-store wiring)', () => {
  it('Test 26: workspace add results in a 0600 config file on POSIX', async () => {
    if (process.platform === 'win32') return
    setMockViewerOrgId('org-uuid-acme')
    await runWorkspaceAdd({ name: 'acme', token: 'lin_api_acme', pretty: false })

    const stat = statSync(configFile)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })
})
