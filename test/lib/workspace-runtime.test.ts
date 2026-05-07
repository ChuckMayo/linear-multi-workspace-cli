/**
 * `runCommand` flag-interaction tests (Phase 6 PLAN 06-01, MNT-02).
 *
 * Coverage of the locked CONTEXT decisions for `--quiet` / `--no-meta`:
 *   (a) baseline: neither flag → success envelope identical to Phase 1/2.
 *   (b) noMeta: success envelope has no `meta` key.
 *   (c) quiet + pretty: output is JSON (no banner) AND no `meta` key.
 *   (d) both flags together: identical to either alone.
 *   (e) failure path with both flags: STILL carries full failure meta.
 *
 * Tests use a synthetic handler so no Linear SDK / network is touched.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

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
    constructor(opts?: {
      message?: string
      retryAfter?: number
      complexityRemaining?: number
      complexityLimit?: number
    }) {
      super(opts?.message ?? 'rate limited')
      this.name = 'RatelimitedLinearError'
      if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter
      if (opts?.complexityRemaining !== undefined)
        this.complexityRemaining = opts.complexityRemaining
      if (opts?.complexityLimit !== undefined) this.complexityLimit = opts.complexityLimit
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
  return {
    LinearError,
    RatelimitedLinearError,
    NetworkLinearError,
    AuthenticationLinearError,
    InvalidInputLinearError,
  }
})

import { RatelimitedLinearError as RealRatelimitedLinearError } from '@linear/sdk'
import { LinearAgentError } from '@/core/errors/index.js'
import { type RetryOpts, withRateLimitRetry } from '@/core/transport/index.js'
import { type RunCommandArgs, runCommand } from '@/lib/workspace-runtime.js'

// vi.mock above replaces @linear/sdk at module-load with our own classes
// whose constructors accept a test-friendly options bag. Cast away the
// real SDK constructor signature.
const RatelimitedLinearError = RealRatelimitedLinearError as unknown as new (opts?: {
  message?: string
  retryAfter?: number
  complexityRemaining?: number
  complexityLimit?: number
}) => Error

beforeAll(() => {
  process.env.NO_COLOR = '1'
})

function mkHandler() {
  return async () => ({
    data: { id: 'u1' },
    meta: { workspace: 'acme', workspaceSource: 'flag' as const },
  })
}

function mkFailingHandler() {
  return async (): Promise<{
    data: unknown
    meta: { workspace?: string; workspaceSource?: 'flag' }
  }> => {
    throw new LinearAgentError({ code: 'GENERIC_ERROR', message: 'fail' })
  }
}

/**
 * Capture the `retryOptsOverride` argument that `runCommand` passes into
 * the handler closure. Used by MNT-03 threading tests to assert the
 * operator's --retry flag actually reaches the transport-bound handler.
 */
function mkHandlerCapturingRetry(): {
  handler: RunCommandArgs['handler']
  captured: { override?: RetryOpts }
} {
  const captured: { override?: RetryOpts } = {}
  const handler: RunCommandArgs['handler'] = async (retryOpts) => {
    captured.override = retryOpts
    return {
      data: { id: 'u1' },
      meta: { workspace: 'acme', workspaceSource: 'flag' as const },
    }
  }
  return { handler, captured }
}

describe('runCommand — flag interactions (MNT-02)', () => {
  it('(a) baseline: neither flag → standard success envelope with meta', async () => {
    const out = await runCommand({
      commandPath: 'me',
      pretty: false,
      handler: mkHandler(),
    })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout)
    expect(env).toEqual({
      $apiVersion: '1',
      ok: true,
      data: { id: 'u1' },
      meta: {
        command: 'me',
        workspace: 'acme',
        workspaceSource: 'flag',
      },
    })
  })

  it('(b) noMeta: success envelope drops the meta key', async () => {
    const out = await runCommand({
      commandPath: 'me',
      pretty: false,
      noMeta: true,
      handler: mkHandler(),
    })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout)
    expect('meta' in env).toBe(false)
    expect(env.$apiVersion).toBe('1')
    expect(env.ok).toBe(true)
    expect(env.data).toEqual({ id: 'u1' })
  })

  it('(c) quiet + pretty: output is JSON (no banner) and no meta key', async () => {
    const out = await runCommand({
      commandPath: 'me',
      pretty: true,
      quiet: true,
      handler: mkHandler(),
    })
    expect(out.exitCode).toBe(0)
    // JSON output, not pretty-mode banner. Pretty banners start with `# `.
    expect(out.stdout.startsWith('{')).toBe(true)
    const env = JSON.parse(out.stdout)
    expect('meta' in env).toBe(false)
    expect(env.data).toEqual({ id: 'u1' })
  })

  it('(d) both flags: equivalent to either alone', async () => {
    const out = await runCommand({
      commandPath: 'me',
      pretty: false,
      quiet: true,
      noMeta: true,
      handler: mkHandler(),
    })
    expect(out.exitCode).toBe(0)
    const env = JSON.parse(out.stdout)
    expect(env).toEqual({
      $apiVersion: '1',
      ok: true,
      data: { id: 'u1' },
    })
  })

  it('(e) failure preserves meta even with quiet + noMeta', async () => {
    const out = await runCommand({
      commandPath: 'me',
      pretty: false,
      quiet: true,
      noMeta: true,
      handler: mkFailingHandler(),
    })
    // GENERIC_ERROR exit code (transient: false) maps to 1.
    expect(out.exitCode).toBeGreaterThan(0)
    const env = JSON.parse(out.stdout)
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('GENERIC_ERROR')
    // Failure path is byte-identical to Phase 1 — meta still carries command.
    expect(env.meta).toBeDefined()
    expect(env.meta.command).toBe('me')
  })
})

describe('runCommand — retry threading (MNT-03)', () => {
  it('(g) runCommand({ retry: 2 }) threads extraAttempts: 2 and an onRetry writer into handler', async () => {
    const { handler, captured } = mkHandlerCapturingRetry()
    await runCommand({ commandPath: 'me', pretty: false, retry: 2, handler })
    expect(captured.override?.extraAttempts).toBe(2)
    expect(typeof captured.override?.onRetry).toBe('function')
  })

  it('(g2) runCommand({ retry: 2, quiet: true }) threads extraAttempts: 2 but onRetry === undefined', async () => {
    const { handler, captured } = mkHandlerCapturingRetry()
    await runCommand({
      commandPath: 'me',
      pretty: false,
      quiet: true,
      retry: 2,
      handler,
    })
    expect(captured.override?.extraAttempts).toBe(2)
    expect(captured.override?.onRetry).toBeUndefined()
  })

  it('(h) runCommand({ retry: 0 }) threads extraAttempts: 0 (legacy / default behavior)', async () => {
    const { handler, captured } = mkHandlerCapturingRetry()
    await runCommand({ commandPath: 'me', pretty: false, retry: 0, handler })
    expect(captured.override?.extraAttempts).toBe(0)
  })

  it('(h2) runCommand without retry flag still threads extraAttempts: 0 (default)', async () => {
    const { handler, captured } = mkHandlerCapturingRetry()
    await runCommand({ commandPath: 'me', pretty: false, handler })
    expect(captured.override?.extraAttempts).toBe(0)
  })

  it('(g3) onRetry writer emits the greppable line shape to process.stderr', async () => {
    const { handler, captured } = mkHandlerCapturingRetry()
    await runCommand({ commandPath: 'me', pretty: false, retry: 1, handler })
    // Capture stderr via the writer the handler received — invoke it with a
    // synthetic info object and assert the written bytes match the greppable
    // contract from CONTEXT D-MNT-03 line 74.
    const writes: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') writes.push(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      captured.override?.onRetry?.({
        attempt: 2,
        total: 4,
        code: 'RATELIMITED',
        backoffMs: 487,
      })
    } finally {
      process.stderr.write = origWrite
    }
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe('[retry 2/4] RATELIMITED: backing off 487ms\n')
    expect(writes[0]).toMatch(/^\[retry \d+\/\d+\] [A-Z_]+: backing off \d+ms\n$/)
  })
})

describe('runCommand — Phase 2 byte-identity for default-flag transient exhaustion (CR-01, WR-05)', () => {
  it('(i) default-flag runCommand: transient-exhaustion failure envelope does NOT carry details.attempts', async () => {
    // Drive a transient-exhaustion through `runCommand` with no flags. The
    // handler forwards `retryOptsOverride` into `withRateLimitRetry` exactly
    // the way the production `me`/`whoami` handlers do. Pre-CR-01 this would
    // tag `details.attempts` because runCommand always wired `onRetry`; now
    // the override resolves to `{ extraAttempts: 0 }` and the failure shape
    // matches Phase 2 byte-identity.
    const handler: RunCommandArgs['handler'] = async (retryOpts) => {
      // Deterministic seams so the test never sleeps.
      const seamedOpts: RetryOpts = {
        ...retryOpts,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }
      const data = await withRateLimitRetry(async () => {
        throw new RatelimitedLinearError({ complexityRemaining: 99, complexityLimit: 1000 })
      }, seamedOpts)
      // Unreachable — the thunk always throws.
      return { data, meta: { workspace: 'acme', workspaceSource: 'flag' as const } }
    }
    const out = await runCommand({ commandPath: 'me', pretty: false, handler })
    expect(out.exitCode).toBeGreaterThan(0)
    const env = JSON.parse(out.stdout)
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('RATELIMITED')
    // Phase 2 byte-identity: attempts MUST NOT be tagged when the operator
    // did not opt in via --retry. The SDK-derived complexity fields stay.
    expect(env.error.details).toBeDefined()
    expect(env.error.details.attempts).toBeUndefined()
    expect(env.error.details.complexityRemaining).toBe(99)
    expect(env.error.details.complexityLimit).toBe(1000)
  })

  it('(i2) runCommand({ retry: 2 }) DOES tag details.attempts on exhaustion (opt-in)', async () => {
    const handler: RunCommandArgs['handler'] = async (retryOpts) => {
      const seamedOpts: RetryOpts = {
        ...retryOpts,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      }
      const data = await withRateLimitRetry(async () => {
        throw new RatelimitedLinearError({ complexityRemaining: 0, complexityLimit: 1000 })
      }, seamedOpts)
      return { data, meta: { workspace: 'acme', workspaceSource: 'flag' as const } }
    }
    const out = await runCommand({ commandPath: 'me', pretty: false, retry: 2, handler })
    expect(out.exitCode).toBeGreaterThan(0)
    const env = JSON.parse(out.stdout)
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('RATELIMITED')
    // Opt-in path: 3 default + 2 extra = 5 attempts.
    expect(env.error.details.attempts).toBe(5)
  })
})
