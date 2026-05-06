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
import { beforeAll, describe, expect, it } from 'vitest'
import { LinearAgentError } from '@/core/errors/index.js'
import { runCommand } from '@/lib/workspace-runtime.js'

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
