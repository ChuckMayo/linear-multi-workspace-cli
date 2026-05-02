import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LinearAgentError } from '@/core/errors/index.js'
import { ConfigSchema, WorkspaceEntrySchema, type Config } from '@/core/config/schema.js'
import { configDir, configPath } from '@/core/config/paths.js'
import { loadConfig, saveConfig, updateConfig } from '@/core/config/store.js'

describe('ConfigSchema (Zod schema)', () => {
  it('parses an empty config (active: null, no workspaces)', () => {
    const parsed = ConfigSchema.parse({ active: null, workspaces: {} })
    expect(parsed).toEqual({ active: null, workspaces: {} })
  })

  it('parses a config with one workspace and active set', () => {
    const input = {
      active: 'acme',
      workspaces: {
        acme: {
          name: 'acme',
          token: 'lin_api_xxx',
          organizationId: 'org-uuid',
          createdAt: '2026-05-02T00:00:00Z',
        },
      },
    }
    const parsed = ConfigSchema.parse(input)
    expect(parsed).toEqual(input)
  })

  it('rejects when active references an unregistered workspace (refine)', () => {
    const result = ConfigSchema.safeParse({ active: 'acme', workspaces: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('active'))).toBe(true)
    }
  })

  it('rejects when active is missing (active is required, even if null)', () => {
    const result = ConfigSchema.safeParse({ workspaces: {} })
    expect(result.success).toBe(false)
  })
})

describe('WorkspaceEntrySchema', () => {
  it('parses a full entry with lastUsedAt', () => {
    const input = {
      name: 'acme',
      token: 'lin_api_x',
      organizationId: 'o',
      createdAt: '2026-05-02T00:00:00Z',
      lastUsedAt: '2026-05-02T00:00:00Z',
    }
    expect(WorkspaceEntrySchema.parse(input)).toEqual(input)
  })

  it('parses an entry without lastUsedAt (optional)', () => {
    const input = {
      name: 'acme',
      token: 'lin_api_x',
      organizationId: 'o',
      createdAt: '2026-05-02T00:00:00Z',
    }
    expect(WorkspaceEntrySchema.parse(input)).toEqual(input)
  })

  it('rejects an entry with missing token', () => {
    const result = WorkspaceEntrySchema.safeParse({
      name: 'acme',
      organizationId: 'o',
      createdAt: '2026-05-02T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty-string fields', () => {
    const result = WorkspaceEntrySchema.safeParse({
      name: '',
      token: '',
      organizationId: '',
      createdAt: '2026-05-02T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })
})

describe('paths (configDir / configPath)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('honors XDG_CONFIG_HOME when set', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/xdg')
    expect(configDir()).toBe('/tmp/xdg/linear-agent')
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(configDir()).toBe(join(homedir(), '.config', 'linear-agent'))
  })

  it('configPath() returns configDir() + /config.json', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/xdg')
    expect(configPath()).toBe('/tmp/xdg/linear-agent/config.json')
  })
})

const isWindows = process.platform === 'win32'
const skipOnWindows = isWindows ? it.skip : it

const SAMPLE_CONFIG: Config = {
  active: 'acme',
  workspaces: {
    acme: {
      name: 'acme',
      token: 'lin_api_xxx',
      organizationId: 'org-uuid',
      createdAt: '2026-05-02T00:00:00Z',
    },
  },
}

describe('ConfigStore (loadConfig / saveConfig)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'linear-agent-test-'))
    path = join(dir, 'config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadConfig on missing file returns the empty config (CONFIG_NOT_FOUND -> empty)', () => {
    const cfg = loadConfig({ path })
    expect(cfg).toEqual({ active: null, workspaces: {} })
  })

  skipOnWindows('saveConfig writes the file with mode 0600', () => {
    saveConfig({ active: null, workspaces: {} }, { path })
    const mode = statSync(path).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  it('saveConfig is atomic — no *.tmp.* files remain after save', () => {
    saveConfig(SAMPLE_CONFIG, { path })
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })

  skipOnWindows('saveConfig creates the parent directory with mode 0700 when missing', () => {
    const nested = join(dir, 'nested-cfg-dir')
    const nestedPath = join(nested, 'config.json')
    saveConfig({ active: null, workspaces: {} }, { path: nestedPath })
    const dirMode = statSync(nested).mode & 0o777
    expect(dirMode.toString(8)).toBe('700')
  })

  skipOnWindows('loadConfig refuses a 0644 file with CONFIG_PERMISSIONS_TOO_BROAD', () => {
    saveConfig({ active: null, workspaces: {} }, { path })
    chmodSync(path, 0o644)
    let err: unknown
    try {
      loadConfig({ path })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LinearAgentError)
    if (err instanceof LinearAgentError) {
      expect(err.code).toBe('CONFIG_PERMISSIONS_TOO_BROAD')
      expect(err.details?.path).toBe(path)
    }
  })

  skipOnWindows('loadConfig accepts a 0600 file', () => {
    saveConfig(SAMPLE_CONFIG, { path })
    chmodSync(path, 0o600)
    const cfg = loadConfig({ path })
    expect(cfg).toEqual(SAMPLE_CONFIG)
  })

  skipOnWindows('loadConfig on malformed JSON throws VALIDATION_FAILED', () => {
    writeFileSync(path, '{ not valid json', { mode: 0o600 })
    chmodSync(path, 0o600)
    let err: unknown
    try {
      loadConfig({ path })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LinearAgentError)
    if (err instanceof LinearAgentError) {
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details?.stage).toBe('json-parse')
    }
  })

  skipOnWindows('loadConfig on schema-violating JSON throws VALIDATION_FAILED', () => {
    // active set but workspace not registered violates the refine()
    writeFileSync(path, JSON.stringify({ active: 'acme', workspaces: {} }), { mode: 0o600 })
    chmodSync(path, 0o600)
    let err: unknown
    try {
      loadConfig({ path })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LinearAgentError)
    if (err instanceof LinearAgentError) {
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details?.stage).toBe('schema')
    }
  })

  it('round-trip: saveConfig then loadConfig returns deep-equal data', () => {
    saveConfig(SAMPLE_CONFIG, { path })
    const cfg = loadConfig({ path })
    expect(cfg).toEqual(SAMPLE_CONFIG)
  })

  it('updateConfig loads, mutates, saves', () => {
    saveConfig(SAMPLE_CONFIG, { path })
    const next = updateConfig(
      (c) => ({
        ...c,
        workspaces: {
          ...c.workspaces,
          acme: { ...c.workspaces.acme!, lastUsedAt: '2026-05-02T01:00:00Z' },
        },
      }),
      { path },
    )
    expect(next.workspaces.acme?.lastUsedAt).toBe('2026-05-02T01:00:00Z')
    const reloaded = loadConfig({ path })
    expect(reloaded.workspaces.acme?.lastUsedAt).toBe('2026-05-02T01:00:00Z')
  })

  it('concurrent-safety smoke: two parallel saves produce one of the two valid configs', async () => {
    const a: Config = { active: null, workspaces: {} }
    const b: Config = SAMPLE_CONFIG
    await Promise.all([
      Promise.resolve().then(() => saveConfig(a, { path })),
      Promise.resolve().then(() => saveConfig(b, { path })),
    ])
    const final = loadConfig({ path })
    // The final state must be a deep-equal match of one of the two writers' inputs;
    // never a partial/interleaved write.
    const matchesA = JSON.stringify(final) === JSON.stringify(a)
    const matchesB = JSON.stringify(final) === JSON.stringify(b)
    expect(matchesA || matchesB).toBe(true)
  })
})

