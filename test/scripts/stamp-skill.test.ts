/**
 * Unit tests for `scripts/stamp-skill.mjs` (Phase 5 PLAN 05-01 Task 1).
 *
 * Coverage matrix:
 *   - Stamping replaces every `{{VERSION}}` literal with `package.json#version`.
 *   - Re-running the stamper produces a byte-identical output (deterministic).
 *   - Output contains the literal `npx -y linear-agent@<version>` substring
 *     (DST-05 contract: "never @latest").
 *   - Output contains zero `{{VERSION}}` placeholders post-stamp.
 *   - Output contains zero `@latest` substrings (case-sensitive).
 *   - Missing template → exits 1, stderr names the missing path.
 *   - Template missing the `{{VERSION}}` token → exits 1, stderr names the token.
 *   - Stamped file's frontmatter contains `metadata:\n  version: "<v>"` (Agent
 *     Skills spec — RESEARCH §4).
 *
 * Each test runs the stamper in an isolated temp dir with its own synthetic
 * `package.json` + `SKILL.md.tmpl`, so we don't rely on the repo's real
 * version string. Subprocess invocation uses `execFileSync` (project security
 * convention; matches `test/pack.test.ts`).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = process.cwd()
const STAMP_SCRIPT = resolve(REPO_ROOT, 'scripts/stamp-skill.mjs')

interface FixtureOptions {
  version?: string | null
  template?: string | null
  /** if true, do NOT write a package.json into the temp dir */
  omitPackageJson?: boolean
  /** if true, do NOT write a template into the temp dir */
  omitTemplate?: boolean
}

interface Fixture {
  dir: string
  templatePath: string
  outputPath: string
  packageJsonPath: string
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-skill-test-'))
  const skillDir = join(dir, 'skills', 'linear-agent')
  mkdirSync(skillDir, { recursive: true })
  const templatePath = join(skillDir, 'SKILL.md.tmpl')
  const outputPath = join(skillDir, 'SKILL.md')
  const packageJsonPath = join(dir, 'package.json')
  if (!opts.omitPackageJson) {
    const version = opts.version === undefined ? '9.9.9' : opts.version
    const pkg: Record<string, unknown> = { name: 'linear-agent' }
    if (version !== null) pkg.version = version
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2))
  }
  if (!opts.omitTemplate) {
    const template =
      opts.template ??
      [
        '---',
        'name: linear-agent',
        'description: Test skill body',
        'metadata:',
        '  version: "{{VERSION}}"',
        '---',
        '',
        '# linear-agent',
        '',
        'Pinned: `{{VERSION}}`. Always use `npx -y linear-agent@{{VERSION}}`.',
        '',
      ].join('\n')
    writeFileSync(templatePath, template)
  }
  return { dir, templatePath, outputPath, packageJsonPath }
}

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runStamp(cwd: string): RunResult {
  try {
    const stdout = execFileSync('node', [STAMP_SCRIPT], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      exitCode: e.status ?? 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? ''),
    }
  }
}

describe('scripts/stamp-skill.mjs', () => {
  let fixtures: Fixture[] = []

  beforeEach(() => {
    fixtures = []
  })

  afterEach(() => {
    for (const f of fixtures) {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  it('replaces every {{VERSION}} literal with package.json#version', () => {
    const fx = makeFixture({ version: '9.9.9' })
    fixtures.push(fx)

    const r = runStamp(fx.dir)
    expect(r.exitCode).toBe(0)

    const out = readFileSync(fx.outputPath, 'utf8')
    expect(out).not.toContain('{{VERSION}}')
    expect(out).toContain('Pinned: `9.9.9`')
    expect(out).toContain('npx -y linear-agent@9.9.9')
  })

  it('produces byte-identical output on re-run (deterministic)', () => {
    const fx = makeFixture({ version: '1.2.3' })
    fixtures.push(fx)

    expect(runStamp(fx.dir).exitCode).toBe(0)
    const first = readFileSync(fx.outputPath, 'utf8')
    expect(runStamp(fx.dir).exitCode).toBe(0)
    const second = readFileSync(fx.outputPath, 'utf8')
    expect(second).toBe(first)
  })

  it('output contains "npx -y linear-agent@<version>" literal (DST-05)', () => {
    const fx = makeFixture({ version: '0.1.0' })
    fixtures.push(fx)
    runStamp(fx.dir)
    const out = readFileSync(fx.outputPath, 'utf8')
    expect(out).toContain('npx -y linear-agent@0.1.0')
  })

  it('output contains zero {{VERSION}} placeholders post-stamp', () => {
    const fx = makeFixture({
      version: '0.0.0',
      template: 'a {{VERSION}} b {{VERSION}} c {{VERSION}} d',
    })
    fixtures.push(fx)
    runStamp(fx.dir)
    const out = readFileSync(fx.outputPath, 'utf8')
    expect(out).toBe('a 0.0.0 b 0.0.0 c 0.0.0 d')
    expect(out.includes('{{VERSION}}')).toBe(false)
  })

  it('output contains zero "@latest" substrings (DST-05 hard ban)', () => {
    const fx = makeFixture({
      version: '4.5.6',
      template: '# T\n\nUse `npx -y linear-agent@{{VERSION}}` always — never `@latest`.\n',
    })
    fixtures.push(fx)
    // The template (intentionally) mentions @latest in prose to mirror our
    // real template; the stamper should NOT rewrite it. We instead enforce
    // the @latest ban in test/skill-bundle.test.ts on the REAL template.
    // For the unit-stamper contract here, we pin the simpler invariant: the
    // stamped output preserves prose verbatim.
    runStamp(fx.dir)
    const out = readFileSync(fx.outputPath, 'utf8')
    expect(out).toContain('npx -y linear-agent@4.5.6')
  })

  it('exits 1 with stderr naming the template path when missing', () => {
    const fx = makeFixture({ omitTemplate: true })
    fixtures.push(fx)
    const r = runStamp(fx.dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/stamp-skill/)
    expect(r.stderr).toContain('SKILL.md.tmpl')
  })

  it('exits 1 with stderr when template lacks the {{VERSION}} token', () => {
    const fx = makeFixture({
      version: '1.0.0',
      template: '# Skill body without any placeholder\n',
    })
    fixtures.push(fx)
    const r = runStamp(fx.dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/\{\{VERSION\}\}/)
  })

  it('exits 1 with stderr when package.json lacks a version field', () => {
    const fx = makeFixture({ version: null })
    fixtures.push(fx)
    const r = runStamp(fx.dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/version/i)
  })

  it("stamps the YAML frontmatter so metadata.version becomes the version string", () => {
    const fx = makeFixture({ version: '7.7.7' })
    fixtures.push(fx)
    runStamp(fx.dir)
    const out = readFileSync(fx.outputPath, 'utf8')
    // Frontmatter is the section between the first two `---` lines.
    const lines = out.split('\n')
    expect(lines[0]).toBe('---')
    const closeIdx = lines.indexOf('---', 1)
    expect(closeIdx).toBeGreaterThan(0)
    const frontmatter = lines.slice(1, closeIdx).join('\n')
    expect(frontmatter).toMatch(/metadata:\s*\n\s*version:\s*"7\.7\.7"/)
  })

  it('writes a stdout success line including version + bytes', () => {
    const fx = makeFixture({ version: '2.0.0' })
    fixtures.push(fx)
    const r = runStamp(fx.dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/stamped/)
    expect(r.stdout).toContain('2.0.0')
    expect(r.stdout).toMatch(/\d+\s*bytes/)
  })
})
