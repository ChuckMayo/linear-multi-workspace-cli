/**
 * Contract tests for the published Claude Code skill bundle (Phase 5 PLAN
 * 05-01 Task 2, DST-05).
 *
 * These run AFTER `node scripts/stamp-skill.mjs` produces the stamped
 * `skills/linmux/SKILL.md` from the checked-in `.tmpl`. They pin the
 * invariants that the published bundle must satisfy:
 *
 *   - File exists at the expected path
 *   - Body is ≤ 500 lines (DST-05 hard cap; soft target 350)
 *   - Body contains the literal version pulled from package.json (proves the
 *     stamper actually ran AND used the real version)
 *   - Body contains zero `@latest` substrings (case-sensitive — DST-05 ban)
 *   - YAML frontmatter parses, has `name === 'linmux'`, has
 *     `metadata.version === package.json#version`, has `description ≤ 500`
 *     chars (Claude Code listing truncates at 1,536; we cap at 500 per
 *     RESEARCH §10 P9)
 *
 * Snapshot intentionally NOT used — humans will edit prose; pinning a
 * `.snap` would create churn. Behavioral assertions only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const STAMP_SCRIPT = resolve(ROOT, 'scripts/stamp-skill.mjs')
const TEMPLATE = resolve(ROOT, 'skills/linmux/SKILL.md.tmpl')
const STAMPED = resolve(ROOT, 'skills/linmux/SKILL.md')

interface SkillFrontmatter {
  name?: string
  description?: string
  compatibility?: string
  metadata?: { version?: string; homepage?: string }
}

function parseFrontmatter(body: string): SkillFrontmatter {
  const lines = body.split('\n')
  if (lines[0] !== '---') {
    throw new Error('SKILL.md does not start with `---` frontmatter delimiter')
  }
  const closeIdx = lines.indexOf('---', 1)
  if (closeIdx === -1) {
    throw new Error('SKILL.md frontmatter has no closing `---` delimiter')
  }
  const frontmatter = lines.slice(1, closeIdx).join('\n')
  return yaml.load(frontmatter) as SkillFrontmatter
}

describe('skills/linmux/SKILL.md contract (DST-05)', () => {
  let pkgVersion: string

  beforeAll(() => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      version?: string
    }
    if (typeof pkg.version !== 'string') {
      throw new Error('package.json has no version field')
    }
    pkgVersion = pkg.version
    // Ensure the stamped file exists for the assertions below. The pack
    // contract integration test (test/pack.test.ts) also runs the stamper
    // in its own beforeAll; doing it here keeps this file self-sufficient.
    execFileSync('node', [STAMP_SCRIPT], { stdio: 'pipe' })
  }, 30_000)

  it('template is checked in', () => {
    expect(existsSync(TEMPLATE)).toBe(true)
  })

  it('stamped file exists after stamping', () => {
    expect(existsSync(STAMPED)).toBe(true)
  })

  it('stamped body is ≤ 500 lines (DST-05 hard cap)', () => {
    const text = readFileSync(STAMPED, 'utf8')
    const lineCount = text.split('\n').length
    expect(lineCount).toBeLessThanOrEqual(500)
  })

  it('stamped body contains the package.json version literal', () => {
    const text = readFileSync(STAMPED, 'utf8')
    expect(text).toContain(pkgVersion)
    expect(text).toContain(`linmux@${pkgVersion}`)
  })

  it('stamped body contains zero {{VERSION}} placeholders', () => {
    const text = readFileSync(STAMPED, 'utf8')
    expect(text.includes('{{VERSION}}')).toBe(false)
  })

  it('stamped body contains zero "@latest" substrings (DST-05 ban)', () => {
    const text = readFileSync(STAMPED, 'utf8')
    expect(text.includes('@latest')).toBe(false)
  })

  it('frontmatter parses as YAML', () => {
    const text = readFileSync(STAMPED, 'utf8')
    expect(() => parseFrontmatter(text)).not.toThrow()
  })

  it('frontmatter.name === "linmux"', () => {
    const fm = parseFrontmatter(readFileSync(STAMPED, 'utf8'))
    expect(fm.name).toBe('linmux')
  })

  it('frontmatter.metadata.version === package.json#version', () => {
    const fm = parseFrontmatter(readFileSync(STAMPED, 'utf8'))
    expect(fm.metadata?.version).toBe(pkgVersion)
  })

  it('frontmatter.description is ≤ 500 chars (Claude Code listing truncation guard)', () => {
    const fm = parseFrontmatter(readFileSync(STAMPED, 'utf8'))
    expect(typeof fm.description).toBe('string')
    expect((fm.description ?? '').length).toBeLessThanOrEqual(500)
  })

  it('template (.tmpl) is also ≤ 500 lines', () => {
    const text = readFileSync(TEMPLATE, 'utf8')
    expect(text.split('\n').length).toBeLessThanOrEqual(500)
  })

  it('template contains the {{VERSION}} placeholder', () => {
    const text = readFileSync(TEMPLATE, 'utf8')
    expect(text.includes('{{VERSION}}')).toBe(true)
  })
})
