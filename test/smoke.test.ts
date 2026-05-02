import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const BIN = 'bin/run.js'

describe('phase-1 smoke test', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
  })

  let tmpHome: string
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'linear-agent-smoke-'))
  })
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('node bin/run.js --help exits 0 and lists the workspace topic', () => {
    const out = execFileSync('node', [BIN, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/linear-agent/i)
    // The `workspace` topic is registered automatically because oclif sees
    // commands under `dist/commands/workspace/`. Help output mentions it.
    expect(out).toMatch(/workspace/)
  })

  it('workspace list (empty config) emits the Phase 1 envelope end-to-end', () => {
    const out = execFileSync('node', [BIN, 'workspace', 'list', '--json'], {
      env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // The CLI writes the envelope to stdout. oclif's --json shim re-emits the
    // returned object as a second JSON line; we accept either the first or
    // last parseable JSON.
    const parsed = (() => {
      const trimmed = out.trim()
      // Try parsing the whole thing first.
      try {
        return JSON.parse(trimmed)
      } catch {}
      // Fall back to the first line (our envelope is always one line of JSON + \n).
      const firstLine = trimmed.split('\n')[0]
      return JSON.parse(firstLine ?? '{}')
    })()
    expect(parsed.$apiVersion).toBe('1')
    expect(parsed.ok).toBe(true)
    expect(parsed.data.workspaces).toEqual([])
    expect(parsed.meta.command).toBe('workspace list')
  })
})
