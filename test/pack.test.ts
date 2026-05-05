import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const VERIFY_SCRIPT = resolve(ROOT, 'scripts/verify-pack.mjs')
const STAMP_SCRIPT = resolve(ROOT, 'scripts/stamp-skill.mjs')
const STAMPED_SKILL = resolve(ROOT, 'skills/linear-agent/SKILL.md')

function runStamp(): void {
  execFileSync('node', [STAMP_SCRIPT], { stdio: 'pipe' })
}

describe('npm pack contract', () => {
  beforeAll(() => {
    // verify-pack does not build; ensure dist/ is fresh so the file list is correct.
    // Also stamp the skill bundle so it appears in the dry-run output (Phase 5).
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
    runStamp()
  }, 60_000)

  afterAll(() => {
    // Re-stamp after the suite so subsequent test files (or developer tools
    // running after vitest) see the stamped file in the expected state.
    runStamp()
  })

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

  // ─── Phase 5 PLAN 05-01 Task 2 ──────────────────────────────────────────
  // Skill bundle wiring is now part of the pack contract.

  it('package.json#files includes "skills"', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(pkg.files).toBeDefined()
    expect(pkg.files).toContain('skills')
  })

  it('package.json#prepack chains build → manifest → stamp-skill', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const prepack = pkg.scripts?.prepack ?? ''
    expect(prepack).toMatch(/npm run build.*oclif manifest.*node scripts\/stamp-skill\.mjs/)
  })

  it('package.json#postpack cleans both stamped artifacts', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const postpack = pkg.scripts?.postpack ?? ''
    expect(postpack).toMatch(/oclif\.manifest\.json/)
    expect(postpack).toMatch(/skills\/linear-agent\/SKILL\.md/)
  })

  it('verify-pack lists skills/linear-agent/SKILL.md as required', () => {
    // Soft check on the script source: the prefix must be in REQUIRED_PREFIXES.
    // (The end-to-end "verify-pack exits 0" test above already proves it works
    // when the file is present; this one pins the contract textually so a
    // future refactor of verify-pack.mjs that drops the prefix is caught.)
    const verifySrc = readFileSync(VERIFY_SCRIPT, 'utf8')
    expect(verifySrc).toMatch(/skills\/linear-agent\/SKILL\.md/)
  })

  it('verify-pack rejects when skills/linear-agent/SKILL.md is missing', () => {
    // Delete the stamped file (template stays). verify-pack must fail.
    rmSync(STAMPED_SKILL, { force: true })
    let exitCode = 0
    let stderr = ''
    try {
      execFileSync('node', [VERIFY_SCRIPT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string | Buffer }
      exitCode = e.status ?? 1
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '')
    } finally {
      // ALWAYS re-stamp so subsequent assertions in this suite (and other
      // suites) see a healthy bundle.
      runStamp()
    }
    expect(exitCode).toBeGreaterThan(0)
    expect(stderr).toMatch(/MISSING REQUIRED.*skills\/linear-agent\/SKILL\.md/)
  }, 60_000)
})
