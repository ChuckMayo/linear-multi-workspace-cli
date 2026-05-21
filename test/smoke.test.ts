import { execFileSync, spawnSync } from 'node:child_process'
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
    // Regression: stdout under --json MUST be a single JSON document.
    // Earlier the CLI emitted both the envelope (direct stdout write) AND
    // oclif's framework re-emission, producing two documents that broke
    // every agent-side JSON.parse pipeline.
    const parsed = JSON.parse(out)
    expect(parsed.$apiVersion).toBe('1')
    expect(parsed.ok).toBe(true)
    expect(parsed.data.workspaces).toEqual([])
    expect(parsed.meta.command).toBe('workspace list')
  })

  it('--json failure envelope is the canonical shape, NOT oclif EEXIT shim', () => {
    // Regression: `this.exit(N)` under --json mode used to surface as
    // `{ error: { code: "EEXIT", oclif: { exit: N } } }` instead of the
    // canonical failure envelope. The fix sets `process.exitCode` and
    // returns the envelope so oclif's --json printer emits it directly.
    const res = spawnSync('node', [BIN, 'workspace', 'use', 'does-not-exist', '--json'], {
      env: { ...process.env, XDG_CONFIG_HOME: tmpHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(res.status).not.toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.$apiVersion).toBe('1')
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBeTypeOf('string')
    expect(parsed.error.code).not.toBe('EEXIT')
    expect(parsed.meta.command).toBe('workspace use')
  })
})
