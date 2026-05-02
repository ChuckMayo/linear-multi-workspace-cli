import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigSchema, WorkspaceEntrySchema } from '@/core/config/schema.js'
import { configDir, configPath } from '@/core/config/paths.js'

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
