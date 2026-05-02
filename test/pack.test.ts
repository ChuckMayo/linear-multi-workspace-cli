import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const VERIFY_SCRIPT = resolve(ROOT, 'scripts/verify-pack.mjs')

describe('npm pack contract', () => {
  beforeAll(() => {
    // verify-pack does not build; ensure dist/ is fresh so the file list is correct
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
  }, 60_000)

  it('scripts/verify-pack.mjs exists', () => {
    expect(existsSync(VERIFY_SCRIPT)).toBe(true)
  })

  it('verify-pack script exits 0 against the current build', () => {
    const out = execFileSync('node', [VERIFY_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/pack contract verified/i)
  }, 60_000)

  it('npm run verify-pack is wired up in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['verify-pack']).toBeTruthy()
    expect(pkg.scripts?.['verify-pack']).toContain('scripts/verify-pack.mjs')
  })
})
