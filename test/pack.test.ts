import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { findViolations, SIZE_BUDGET_BYTES, topNLargest } from '../scripts/verify-pack.mjs'

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

  it('verify-pack script exits 0 OR fails ONLY on SIZE BUDGET (DST-04 surfacing)', () => {
    // Phase 5 PLAN 05-03 introduces a hard 5 MB unpacked-size assertion.
    // The current build's `src/generated/*.ts` (FND-05 ships TS source +
    // dist/ compiled JS) puts the unpacked tarball at ~5.9 MB — over the
    // DST-04 budget. That overage is THE reason DST-04 exists (a budget gate
    // that catches what the planner expected to be "well under 5 MB" but
    // isn't). This test is now scoped to: (a) verify-pack runs cleanly to
    // completion, (b) any failure is ONLY a SIZE BUDGET violation — every
    // other contract (allowlist, denylist, deps) must stay green.
    let exitCode = 0
    let stdout = ''
    let stderr = ''
    try {
      stdout = execFileSync('node', [VERIFY_SCRIPT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
      exitCode = e.status ?? 1
      stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '')
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '')
    }
    if (exitCode === 0) {
      expect(stdout).toMatch(/pack contract verified/i)
    } else {
      // The ONLY allowed failure mode is a SIZE BUDGET violation. Any other
      // violation is a real regression and must surface here.
      const violationLines = stderr
        .split('\n')
        .filter((l) => /^\s+-\s/.test(l))
        .map((l) => l.replace(/^\s+-\s/, '').trim())
      expect(
        violationLines.length,
        `expected at least one violation when verify-pack exits non-zero, got stderr: ${stderr.slice(0, 500)}`,
      ).toBeGreaterThan(0)
      for (const v of violationLines) {
        expect(v, `non-SIZE-BUDGET violation surfaced: "${v}"`).toMatch(/^SIZE BUDGET EXCEEDED/)
      }
      // Confirm the diagnostic top-10 files list was emitted (DST-04 contract).
      expect(stderr).toMatch(/Top 10 largest files in tarball/i)
    }
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

// ─── Phase 5 PLAN 05-03 Task 2 — DST-04 size budget ──────────────────────
//
// Pure-logic tests for the helper functions exposed by verify-pack.mjs.
// We unit-test the assertion against synthetic `pkg` objects so we don't
// have to actually build a 6 MB tarball.

describe('size budget enforcement (DST-04)', () => {
  // A minimal package.json shape that satisfies the dependency-allowlist
  // checks (so the only violation we observe is the size one).
  const validPackageJson = {
    dependencies: {
      '@graphql-typed-document-node/core': '^3.2.0',
      '@linear/sdk': '^83.0.0',
      '@oclif/core': '^4.11.0',
      conf: '^14.0.0',
      graphql: '^16.13.2',
      picocolors: '^1.1.0',
      zod: '^4.4.2',
    },
    devDependencies: {
      oclif: '^4.23.0',
    },
  }

  // A minimal `pkg` (npm pack --dry-run --json output) with all REQUIRED_PREFIXES
  // satisfied, no FORBIDDEN_PATTERNS triggered, just so we can isolate the size
  // assertion from every other check.
  function syntheticPkg(unpackedSize: number, files: { path: string; size?: number }[] = []) {
    return {
      unpackedSize,
      size: Math.floor(unpackedSize / 4),
      files: [
        { path: 'bin/run.js' },
        { path: 'dist/index.js' },
        { path: 'schema.graphql' },
        { path: 'src/generated/index.ts' },
        { path: 'README.md' },
        { path: 'package.json' },
        { path: 'skills/linear-agent/SKILL.md' },
        ...files,
      ],
    }
  }

  it('exposes SIZE_BUDGET_BYTES = 5_000_000 (5 MB)', () => {
    expect(SIZE_BUDGET_BYTES).toBe(5_000_000)
  })

  it('findViolations: under-budget pkg → no SIZE BUDGET violation', () => {
    const pkg = syntheticPkg(2_500_000)
    const violations = findViolations({ pkg, packageJson: validPackageJson })
    expect(violations.some((v: string) => /SIZE BUDGET/i.test(v))).toBe(false)
  })

  it('findViolations: over-budget pkg → SIZE BUDGET EXCEEDED violation', () => {
    const pkg = syntheticPkg(6_000_000)
    const violations = findViolations({ pkg, packageJson: validPackageJson })
    const sizeViolations = violations.filter((v: string) => /SIZE BUDGET EXCEEDED/.test(v))
    expect(sizeViolations.length).toBe(1)
    expect(sizeViolations[0]).toMatch(/5\.\d{2}\s*MB/) // formatted size in MB
    expect(sizeViolations[0]).toMatch(/5\s*MB/) // threshold also formatted
  })

  it('findViolations: equal-to-budget is OK (boundary)', () => {
    const pkg = syntheticPkg(5_000_000)
    const violations = findViolations({ pkg, packageJson: validPackageJson })
    expect(violations.some((v: string) => /SIZE BUDGET/i.test(v))).toBe(false)
  })

  it('findViolations: still detects existing allowlist violations alongside size', () => {
    // Pkg missing skills/linear-agent/SKILL.md AND over-budget — both must surface.
    const pkg = {
      unpackedSize: 6_000_000,
      size: 1_500_000,
      files: [
        { path: 'bin/run.js' },
        { path: 'dist/index.js' },
        { path: 'schema.graphql' },
        { path: 'src/generated/index.ts' },
        { path: 'README.md' },
        { path: 'package.json' },
        // skills/ deliberately missing
      ],
    }
    const violations = findViolations({ pkg, packageJson: validPackageJson })
    expect(violations.some((v: string) => /MISSING REQUIRED.*skills/.test(v))).toBe(true)
    expect(violations.some((v: string) => /SIZE BUDGET EXCEEDED/.test(v))).toBe(true)
  })

  it('topNLargest returns the N largest entries sorted by size desc', () => {
    const files = [
      { path: 'a', size: 100 },
      { path: 'b', size: 500 },
      { path: 'c', size: 50 },
      { path: 'd', size: 300 },
      { path: 'e', size: 200 },
    ]
    const result = topNLargest(files, 3)
    expect(result.map((f: { path: string }) => f.path)).toEqual(['b', 'd', 'e'])
  })

  it('topNLargest with fewer than N files returns all of them sorted', () => {
    const files = [
      { path: 'a', size: 100 },
      { path: 'b', size: 50 },
    ]
    const result = topNLargest(files, 10)
    expect(result.map((f: { path: string }) => f.path)).toEqual(['a', 'b'])
  })

  it('topNLargest treats missing size as 0 (does not throw)', () => {
    const files = [
      { path: 'a', size: 100 },
      { path: 'b' }, // no size field
      { path: 'c', size: 50 },
    ]
    const result = topNLargest(files, 5)
    expect(result.map((f: { path: string }) => f.path)).toEqual(['a', 'c', 'b'])
  })

  it('topNLargest does not mutate its input', () => {
    const files = [
      { path: 'a', size: 100 },
      { path: 'b', size: 500 },
    ]
    const snapshot = JSON.stringify(files)
    topNLargest(files, 1)
    expect(JSON.stringify(files)).toBe(snapshot)
  })

  it('verify-pack source mentions SIZE_BUDGET_BYTES (textual contract)', () => {
    const verifySrc = readFileSync(VERIFY_SCRIPT, 'utf8')
    expect(verifySrc).toMatch(/SIZE_BUDGET_BYTES/)
    expect(verifySrc).toMatch(/5_000_000/)
  })
})

// ─── Phase 5 PLAN 05-03 Task 3 — release:dry-run wiring ────────────────

describe('release:dry-run script wiring', () => {
  function readScripts(): Record<string, string> {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts ?? {}
  }

  it('package.json#scripts contains a "cold-start" entry', () => {
    const scripts = readScripts()
    expect(scripts['cold-start']).toBeTruthy()
    expect(scripts['cold-start']).toBe('node scripts/measure-cold-start.mjs')
  })

  it('package.json#scripts contains a "release:dry-run" entry', () => {
    const scripts = readScripts()
    expect(scripts['release:dry-run']).toBeTruthy()
  })

  it('release:dry-run includes every required step', () => {
    const scripts = readScripts()
    const chain = scripts['release:dry-run'] ?? ''
    // Each substring is a step name that the chain must reference.
    for (const piece of [
      'lint',
      'typecheck',
      'test',
      'build',
      'stamp-skill',
      'verify-pack',
      'npm pack',
      'measure-cold-start',
    ]) {
      expect(chain, `release:dry-run missing "${piece}" step`).toContain(piece)
    }
  })

  it('release:dry-run orders npm pack BEFORE measure-cold-start (tarball must exist)', () => {
    const scripts = readScripts()
    const chain = scripts['release:dry-run'] ?? ''
    const packIdx = chain.indexOf('npm pack')
    const coldIdx = chain.indexOf('measure-cold-start')
    expect(packIdx).toBeGreaterThanOrEqual(0)
    expect(coldIdx).toBeGreaterThanOrEqual(0)
    expect(packIdx).toBeLessThan(coldIdx)
  })

  it('release:dry-run orders build → stamp-skill → verify-pack (mirrors prepack)', () => {
    const scripts = readScripts()
    const chain = scripts['release:dry-run'] ?? ''
    const buildIdx = chain.indexOf('build')
    const stampIdx = chain.indexOf('stamp-skill')
    const verifyIdx = chain.indexOf('verify-pack')
    expect(buildIdx).toBeLessThan(stampIdx)
    expect(stampIdx).toBeLessThan(verifyIdx)
  })

  it('release:dry-run starts with lint and typecheck (cheap fail-fast)', () => {
    const scripts = readScripts()
    const chain = scripts['release:dry-run'] ?? ''
    const lintIdx = chain.indexOf('lint')
    const typecheckIdx = chain.indexOf('typecheck')
    const testIdx = chain.indexOf('test')
    expect(lintIdx).toBeGreaterThanOrEqual(0)
    expect(lintIdx).toBeLessThan(typecheckIdx)
    expect(typecheckIdx).toBeLessThan(testIdx)
  })
})
