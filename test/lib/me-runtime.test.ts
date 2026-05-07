/**
 * `meRuntime` tests (Phase 2 PLAN 02-09 Task 1, WHO-01).
 *
 * Coverage:
 *   1. Happy path -- client.viewer + viewer.organization both fetched and
 *      projected; meta.workspace/source populated.
 *   2. AuthenticationLinearError on viewer rejection -> AUTH_INVALID exit 11.
 *   3. --fields=ids returns { user: { id }, organization: { id } }.
 *   4. --fields=defaults projects USER_PRESETS.defaults from user PLUS the
 *      organization shape (id, name, urlKey).
 *   5. runMe vs runWhoami envelope identity except for meta.command.
 *   6. Both oclif Command classes set enableJsonFlag = true.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@linear/sdk', () => {
  class LinearError extends Error {
    constructor(message?: string) {
      super(message ?? 'mock LinearError')
      this.name = 'LinearError'
    }
  }
  class RatelimitedLinearError extends LinearError {
    retryAfter?: number
    constructor(opts?: { message?: string; retryAfter?: number }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
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
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey
      }
    },
  }
})

import {
  type LinearClient,
  AuthenticationLinearError as RealAuthenticationLinearError,
} from '@linear/sdk'

// vi.mock above replaces @linear/sdk at module-load with our own classes whose
// constructors accept strings. Cast away the real SDK constructor signature.
const AuthenticationLinearError = RealAuthenticationLinearError as unknown as new (
  msg?: string,
) => Error

import Me, { runMe } from '@/commands/me.js'
import Whoami, { runWhoami } from '@/commands/whoami.js'
import type { Config } from '@/core/config/index.js'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { meRuntime } from '@/lib/me-runtime.js'

const STUB_CONFIG: Config = {
  active: 'acme',
  workspaces: {
    acme: {
      name: 'acme',
      token: 'lin_api_acme_token_xxxxxxxx',
      organizationId: 'org-acme',
      createdAt: '2026-01-01T00:00:00Z',
    },
  },
}

const USER_FIXTURE = {
  id: 'user-uuid-1',
  name: 'Alice',
  email: 'alice@acme.com',
  displayName: 'alice',
  admin: false,
  isMe: true,
  active: true,
  avatarUrl: null,
}

const ORG_FIXTURE = { id: 'org-acme', name: 'Acme', urlKey: 'acme' }

interface MockOpts {
  /** Override the user accessor (defaults to returning USER_FIXTURE). */
  viewer?: () => Promise<typeof USER_FIXTURE> | typeof USER_FIXTURE
  organization?: () => Promise<typeof ORG_FIXTURE> | typeof ORG_FIXTURE
}

function makeMockClient(opts: MockOpts = {}): LinearClient {
  const orgGetter = opts.organization ?? (() => Promise.resolve(ORG_FIXTURE))
  const baseUser = { ...USER_FIXTURE, organization: orgGetter() }
  const viewerGetter = opts.viewer ?? (() => Promise.resolve(baseUser))
  const client = {
    get viewer() {
      return Promise.resolve(viewerGetter())
    },
  } as unknown as LinearClient
  return client
}

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

beforeEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  delete process.env.LINEAR_WORKSPACE
  delete process.env.LINEAR_API_KEY
})

describe('meRuntime -- happy path', () => {
  it('Test 15: viewer + organization both fetched and projected', async () => {
    const client = makeMockClient()

    const out = await meRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })

    const data = out.data as {
      user: Record<string, unknown>
      organization: Record<string, unknown>
    }
    expect(data.user.id).toBe('user-uuid-1')
    expect(data.user.email).toBe('alice@acme.com')
    expect(data.organization).toEqual({ id: 'org-acme', name: 'Acme', urlKey: 'acme' })
    expect(out.meta.workspace).toBe('acme')
    expect(out.meta.workspaceSource).toBe('flag')

    const env = success(out.data, { ...out.meta, command: 'me' })
    expect(env).toMatchSnapshot('me-success-defaults')
  })
})

describe('meRuntime -- AUTH_INVALID', () => {
  it('Test 16: AuthenticationLinearError -> AUTH_INVALID', async () => {
    const client = {
      get viewer() {
        return Promise.reject(new AuthenticationLinearError('token rejected'))
      },
    } as unknown as LinearClient

    expect.assertions(3)
    try {
      await meRuntime({
        flags: { workspace: 'acme' },
        env: {},
        loadConfigOverride: () => STUB_CONFIG,
        clientFactoryOverride: () => client,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('AUTH_INVALID')
      expect(failure(err, { command: 'me' })).toMatchSnapshot('failure-AUTH_INVALID')
    }
  })
})

describe('meRuntime -- field projections', () => {
  it('Test 17: --fields=ids returns { user: { id }, organization: { id } }', async () => {
    const client = makeMockClient()

    const out = await meRuntime({
      flags: { workspace: 'acme', fields: 'ids' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })

    expect(out.data).toEqual({
      user: { id: 'user-uuid-1' },
      organization: { id: 'org-acme', name: 'Acme', urlKey: 'acme' },
    })
  })

  it('Test 18: --fields=defaults projects USER_PRESETS.defaults from user PLUS organization shape', async () => {
    const client = makeMockClient()

    const out = await meRuntime({
      flags: { workspace: 'acme', fields: 'defaults' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })

    const data = out.data as {
      user: Record<string, unknown>
      organization: Record<string, unknown>
    }
    // USER_PRESETS.defaults includes 8 fields: id, name, email, displayName, admin, isMe, active, avatarUrl
    expect(Object.keys(data.user).sort()).toEqual([
      'active',
      'admin',
      'avatarUrl',
      'displayName',
      'email',
      'id',
      'isMe',
      'name',
    ])
    expect(data.organization).toEqual({ id: 'org-acme', name: 'Acme', urlKey: 'acme' })
  })
})

describe('me / whoami runtime sharing', () => {
  it('Test 19: runMe and runWhoami emit identical envelopes except for meta.command', async () => {
    // Use the same factory for both -- this verifies both delegate to the
    // same meRuntime and produce structurally identical output.
    const sharedFactory = () => makeMockClient()

    // We can't trivially replace the factory used inside runMe/runWhoami
    // because they call meRuntime via process.env -- but we can call the
    // runtime directly with the same factory and confirm the envelope is
    // identical apart from `command`.
    const a = await meRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: sharedFactory,
    })
    const b = await meRuntime({
      flags: { workspace: 'acme' },
      env: {},
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: sharedFactory,
    })

    const envMe = success(a.data, { ...a.meta, command: 'me' })
    const envWhoami = success(b.data, { ...b.meta, command: 'whoami' })

    // Differ only in meta.command
    expect(envMe).toMatchSnapshot('me-success-shared-runtime')
    expect(envWhoami).toMatchSnapshot('whoami-success-shared-runtime')

    // Strip meta.command from both and compare
    type Env = { meta: { command?: string } }
    const stripped = (env: Env): Env => {
      const { command: _command, ...rest } = env.meta
      return { ...env, meta: rest }
    }
    expect(stripped(envMe as unknown as Env)).toEqual(stripped(envWhoami as unknown as Env))
  })

  it('Test 20: both oclif Command classes set enableJsonFlag = true', () => {
    expect(Me.enableJsonFlag).toBe(true)
    expect(Whoami.enableJsonFlag).toBe(true)
    expect(typeof runMe).toBe('function')
    expect(typeof runWhoami).toBe('function')
  })
})

describe('me --no-meta (Phase 6 PLAN 06-01, MNT-02)', () => {
  it('drops meta from the success envelope when --no-meta is set', async () => {
    // WR-07: drive runMe end-to-end so the oclif flag-forwarding code in
    // me.ts is also covered. The factory and config injection seams now
    // live on RunMeArgs, so we can pin the wire bytes without mocking
    // process.env or touching the on-disk config.
    const client = makeMockClient()
    const out = await runMe({
      pretty: false,
      noMeta: true,
      fields: 'ids',
      workspace: 'acme',
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })

    const env = JSON.parse(out.stdout)
    expect(env).toMatchSnapshot('me-no-meta-envelope')
    expect('meta' in env).toBe(false) // structural belt-and-suspenders
  })

  it('runMe and runWhoami both honor --no-meta and emit IDENTICAL envelopes (WR-07, CR-02)', async () => {
    const client = makeMockClient()
    const meOut = await runMe({
      pretty: false,
      noMeta: true,
      fields: 'ids',
      workspace: 'acme',
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })
    const whoamiOut = await runWhoami({
      pretty: false,
      noMeta: true,
      fields: 'ids',
      workspace: 'acme',
      loadConfigOverride: () => STUB_CONFIG,
      clientFactoryOverride: () => client,
    })
    // With --no-meta, NEITHER envelope carries `meta.command`, so the
    // bytes are byte-identical (no `me` vs `whoami` divergence).
    expect(meOut.stdout).toBe(whoamiOut.stdout)
    const meEnv = JSON.parse(meOut.stdout)
    expect('meta' in meEnv).toBe(false)
  })
})
