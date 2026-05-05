/**
 * Unit tests for `scripts/measure-cold-start.mjs` (Phase 5 PLAN 05-03 Task 1).
 *
 * Coverage matrix:
 *   - `median([odd])` returns the middle element.
 *   - `median([odd unsorted])` returns the middle element of the SORTED list.
 *   - `median([even])` returns the average of the middle two.
 *   - `median([single])` returns that single value.
 *   - `median([])` throws (empty input is a programmer error, not 0 / NaN).
 *   - `buildResult({...})` returns the shape `{ ok, runs_ms, median_ms, budget_ms, tarball }`
 *     with `ok` derived from `median_ms <= budget_ms`.
 *   - `findTarball(cwd)` with 0 matching `.tgz` files returns `null`.
 *   - `findTarball(cwd)` with 2 `linear-agent-*.tgz` files returns the most-recently-modified one.
 *   - `findTarball(cwd)` ignores files not matching `^linear-agent-.*\.tgz$`.
 *   - `parseArgs(...)` handles `--key=value` and `--key value` forms; numeric flags coerce; runs is clamped.
 *   - CLI: invoking with `--tarball=./does-not-exist.tgz` exits 1 with stderr mentioning the missing tarball.
 *   - CLI integration test (opt-in via SKIP_COLDSTART_INTEGRATION env): with a real tarball, exits 0 or 1 cleanly
 *     and emits a parseable JSON line on stdout.
 *
 * Pure-logic tests import the named exports directly. The CLI exit-code test uses
 * `execFileSync` against the script (project security convention; matches `test/pack.test.ts`).
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildResult,
  findTarball,
  median,
  parseArgs,
} from '../../scripts/measure-cold-start.mjs'

const REPO_ROOT = process.cwd()
const COLDSTART_SCRIPT = resolve(REPO_ROOT, 'scripts/measure-cold-start.mjs')

describe('scripts/measure-cold-start.mjs — pure logic', () => {
  describe('median(values)', () => {
    it('returns the middle element of an odd-length sorted list', () => {
      expect(median([1, 2, 3, 4, 5])).toBe(3)
    })

    it('returns the middle element after sorting an unsorted list', () => {
      expect(median([5, 1, 4, 2, 3])).toBe(3)
    })

    it('returns the average of the middle two for an even-length list', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5)
    })

    it('returns the single value for a one-element list', () => {
      expect(median([42])).toBe(42)
    })

    it('throws on empty input', () => {
      expect(() => median([])).toThrow()
    })

    it('does not mutate the input array', () => {
      const input = [5, 1, 4, 2, 3]
      median(input)
      expect(input).toEqual([5, 1, 4, 2, 3])
    })
  })

  describe('buildResult({ runs_ms, budget_ms, tarball })', () => {
    it('returns ok=true when median <= budget', () => {
      const r = buildResult({
        runs_ms: [342, 351, 338, 367, 345],
        budget_ms: 500,
        tarball: './x.tgz',
      })
      expect(r).toEqual({
        ok: true,
        runs_ms: [342, 351, 338, 367, 345],
        median_ms: 345,
        budget_ms: 500,
        tarball: './x.tgz',
      })
    })

    it('returns ok=false when median > budget', () => {
      const r = buildResult({
        runs_ms: [600, 610, 605, 620, 615],
        budget_ms: 500,
        tarball: './big.tgz',
      })
      expect(r.ok).toBe(false)
      expect(r.median_ms).toBe(610)
      expect(r.budget_ms).toBe(500)
    })

    it('treats median == budget as ok=true (boundary)', () => {
      const r = buildResult({
        runs_ms: [500, 500, 500],
        budget_ms: 500,
        tarball: './t.tgz',
      })
      expect(r.ok).toBe(true)
      expect(r.median_ms).toBe(500)
    })
  })

  describe('findTarball(cwd)', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'coldstart-find-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns null when no linear-agent-*.tgz files exist', () => {
      writeFileSync(join(tmpDir, 'README.md'), '# nothing')
      expect(findTarball(tmpDir)).toBeNull()
    })

    it('returns the only matching tarball when one exists', () => {
      const tgz = join(tmpDir, 'linear-agent-0.0.0.tgz')
      writeFileSync(tgz, 'fake')
      const found = findTarball(tmpDir)
      expect(found).toBe(tgz)
    })

    it('returns the most-recently-modified tarball when multiple match', () => {
      const a = join(tmpDir, 'linear-agent-0.0.1.tgz')
      const b = join(tmpDir, 'linear-agent-0.0.2.tgz')
      writeFileSync(a, 'fake-a')
      writeFileSync(b, 'fake-b')
      // Force `a` to be older than `b`.
      const past = new Date(Date.now() - 60_000)
      utimesSync(a, past, past)
      const future = new Date()
      utimesSync(b, future, future)
      expect(findTarball(tmpDir)).toBe(b)
      // And confirm the inverse: if `a` is newer, `a` wins.
      const newer = new Date(Date.now() + 60_000)
      utimesSync(a, newer, newer)
      expect(findTarball(tmpDir)).toBe(a)
    })

    it('ignores files that do not match linear-agent-*.tgz', () => {
      writeFileSync(join(tmpDir, 'other-package-1.0.0.tgz'), 'noise')
      writeFileSync(join(tmpDir, 'linear-agent-0.0.0.tgz.bak'), 'noise')
      writeFileSync(join(tmpDir, 'linear-agent.tgz'), 'noise') // no version suffix between dashes
      // Only this one should be discovered:
      const real = join(tmpDir, 'linear-agent-9.9.9.tgz')
      writeFileSync(real, 'real')
      expect(findTarball(tmpDir)).toBe(real)
    })
  })

  describe('parseArgs(argv)', () => {
    it('returns documented defaults when no flags given', () => {
      const a = parseArgs([])
      expect(a.tarball).toBeUndefined()
      expect(a.budget_ms).toBe(500)
      expect(a.runs).toBe(5)
    })

    it('accepts --key=value form', () => {
      const a = parseArgs(['--tarball=./x.tgz', '--budget-ms=1000', '--runs=3'])
      expect(a.tarball).toBe('./x.tgz')
      expect(a.budget_ms).toBe(1000)
      expect(a.runs).toBe(3)
    })

    it('accepts --key value form', () => {
      const a = parseArgs(['--tarball', './y.tgz', '--budget-ms', '750', '--runs', '7'])
      expect(a.tarball).toBe('./y.tgz')
      expect(a.budget_ms).toBe(750)
      expect(a.runs).toBe(7)
    })

    it('rejects negative or non-numeric --runs', () => {
      expect(() => parseArgs(['--runs=-1'])).toThrow()
      expect(() => parseArgs(['--runs=abc'])).toThrow()
      expect(() => parseArgs(['--runs=0'])).toThrow()
    })

    it('clamps --runs to a sane upper bound (DoS guard)', () => {
      // T-05-03-D mitigation: don't let a typoed flag spawn 99999 children.
      expect(() => parseArgs(['--runs=99999'])).toThrow()
    })

    it('rejects negative or non-numeric --budget-ms', () => {
      expect(() => parseArgs(['--budget-ms=-1'])).toThrow()
      expect(() => parseArgs(['--budget-ms=nope'])).toThrow()
    })
  })
})

describe('scripts/measure-cold-start.mjs — CLI', () => {
  it('exits 1 with stderr mentioning the missing tarball when --tarball does not exist', () => {
    let exitCode = 0
    let stderr = ''
    try {
      execFileSync('node', [COLDSTART_SCRIPT, '--tarball=./does-not-exist.tgz'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string | Buffer }
      exitCode = e.status ?? 1
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '')
    }
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/does-not-exist\.tgz/)
  })

  it('exits 1 with stderr when no tarball flag and no tarball found in cwd', () => {
    // Use a temp dir as cwd so we don't accidentally pick up the repo's own .tgz.
    const tmpDir = mkdtempSync(join(tmpdir(), 'coldstart-empty-'))
    let exitCode = 0
    let stderr = ''
    try {
      execFileSync('node', [COLDSTART_SCRIPT], {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string | Buffer }
      exitCode = e.status ?? 1
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? '')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/linear-agent-.*\.tgz/)
  })

  // Real-tarball integration: gated on env so unit-test-only runs are fast.
  it.skipIf(process.env.SKIP_COLDSTART_INTEGRATION === '1')(
    'integration: emits a parseable JSON line on stdout against a real tarball',
    () => {
      // Build + stamp + pack so we have a real tarball to measure against.
      execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
      execFileSync('node', [resolve(REPO_ROOT, 'scripts/stamp-skill.mjs')], { stdio: 'pipe' })
      execFileSync('npm', ['pack', '--ignore-scripts'], { stdio: 'pipe' })

      const matches = readdirSync(REPO_ROOT).filter((f) => /^linear-agent-.*\.tgz$/.test(f))
      expect(matches.length).toBeGreaterThan(0)
      const tarball = matches
        .map((f) => ({ f, mtime: statSync(join(REPO_ROOT, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]!.f

      let exitCode = 0
      let stdout = ''
      try {
        stdout = execFileSync(
          'node',
          [COLDSTART_SCRIPT, `--tarball=./${tarball}`, '--runs=2', '--budget-ms=60000'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (err) {
        const e = err as { status?: number; stdout?: string | Buffer }
        exitCode = e.status ?? 1
        stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '')
      }
      // Either pass (0) or fail (1) — both are clean exits. We only assert shape.
      expect([0, 1]).toContain(exitCode)
      // stdout should contain at least one JSON line we can parse.
      const lines = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'))
      expect(lines.length).toBeGreaterThan(0)
      const parsed = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
      expect(parsed).toHaveProperty('ok')
      expect(parsed).toHaveProperty('runs_ms')
      expect(parsed).toHaveProperty('median_ms')
      expect(parsed).toHaveProperty('budget_ms')
      expect(parsed).toHaveProperty('tarball')
      expect(Array.isArray(parsed.runs_ms)).toBe(true)

      // Cleanup the tarball we created so we don't leave litter.
      rmSync(resolve(REPO_ROOT, tarball), { force: true })
      // Also re-stamp so subsequent suites see a healthy bundle.
      execFileSync('node', [resolve(REPO_ROOT, 'scripts/stamp-skill.mjs')], { stdio: 'pipe' })
    },
    180_000,
  )
})

// Sanity: keep this around so the CLI script lives at the documented path.
it('measure-cold-start.mjs exists at scripts/measure-cold-start.mjs', () => {
  expect(existsSync(COLDSTART_SCRIPT)).toBe(true)
})
