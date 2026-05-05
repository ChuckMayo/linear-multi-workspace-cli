/**
 * `installSkillRuntime` tests — Phase 5 PLAN 05-02 Task 2, DST-06.
 *
 * Coverage:
 *   1. Happy path — fixture SKILL.md with metadata.version "9.9.9"; runtime
 *      reads source, mkdir-p's target dir, writes file, returns envelope
 *      with { source, target, bytes_written, version: '9.9.9', overwritten: false }.
 *   2. Target already existed — overwritten: true.
 *   3. Parent ~/.claude/skills/ did not exist before run — `hint` field present.
 *   4. Parent ~/.claude/skills/ already existed — `hint` field omitted.
 *   5. Source missing (ENOENT) — INSTALL_SKILL_BUNDLE_NOT_FOUND with details.expected_path.
 *   6. Frontmatter unparseable — INSTALL_SKILL_BUNDLE_NOT_FOUND with details.reason='frontmatter_invalid'.
 *   7. Frontmatter missing metadata.version — INSTALL_SKILL_BUNDLE_NOT_FOUND with details.reason='version_missing'.
 *   8. writeFileSync EACCES — INSTALL_SKILL_WRITE_FAILED with details.errno='EACCES'.
 *   9. mkdirSync EACCES — INSTALL_SKILL_WRITE_FAILED.
 *  10. Snapshot: success envelope (stable injected paths, version '9.9.9').
 *  11. Snapshot: failure envelope INSTALL_SKILL_BUNDLE_NOT_FOUND.
 *  12. Snapshot: failure envelope INSTALL_SKILL_WRITE_FAILED.
 */
import * as fsModule from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, success } from '@/core/output/index.js'
import { installSkillRuntime } from '@/lib/install-skill-runtime.js'

// Stable fixture paths used in snapshot tests so the snapshot file is
// byte-stable across machines. The `beforeEach` for snapshot tests creates
// these as real paths under tmpdir so reads/writes work without injecting
// fsOverride.
const STABLE_HOME = '/tmp/linear-agent-install-skill-test-home'
const STABLE_SOURCE_DIR = '/tmp/linear-agent-install-skill-test-source'
const STABLE_SOURCE = path.join(STABLE_SOURCE_DIR, 'SKILL.md')

// Sample SKILL.md body — version "9.9.9" so snapshots are deterministic.
const FIXTURE_BODY = `---
name: linear-agent
description: Test fixture
metadata:
  version: "9.9.9"
---

# linear-agent

Stable test fixture body.
`

let scratchDir: string

function makeScratch(): { home: string; sourceDir: string; source: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'install-skill-test-'))
  const home = path.join(root, 'home')
  const sourceDir = path.join(root, 'source')
  const source = path.join(sourceDir, 'SKILL.md')
  mkdirSync(home, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  scratchDir = root
  return { home, sourceDir, source }
}

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true })
    scratchDir = ''
  }
  // Clean stable paths if they were created by snapshot tests
  for (const p of [STABLE_HOME, STABLE_SOURCE_DIR]) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('installSkillRuntime — happy path', () => {
  it('Test 1: reads source, creates target dir, writes file, returns envelope', async () => {
    const { home, source } = makeScratch()
    writeFileSync(source, FIXTURE_BODY, 'utf8')

    const out = await installSkillRuntime({
      homedirOverride: () => home,
      sourcePathOverride: source,
    })

    expect(out.data.source).toBe(source)
    expect(out.data.target).toBe(path.join(home, '.claude', 'skills', 'linear-agent', 'SKILL.md'))
    expect(out.data.version).toBe('9.9.9')
    expect(out.data.bytes_written).toBe(Buffer.byteLength(FIXTURE_BODY, 'utf8'))
    expect(out.data.overwritten).toBe(false)
    // Parent ~/.claude/skills/ did not exist before the run, so hint is present
    expect(out.data.hint).toBeTypeOf('string')
    expect(out.data.hint).toMatch(/restart claude code/i)

    // File actually written
    expect(fsModule.readFileSync(out.data.target, 'utf8')).toBe(FIXTURE_BODY)
  })

  it('Test 2: target already existed → overwritten: true', async () => {
    const { home, source } = makeScratch()
    writeFileSync(source, FIXTURE_BODY, 'utf8')

    // Pre-create target with stale content so overwritten=true and parent exists
    const targetDir = path.join(home, '.claude', 'skills', 'linear-agent')
    mkdirSync(targetDir, { recursive: true })
    const target = path.join(targetDir, 'SKILL.md')
    writeFileSync(target, 'STALE CONTENT', 'utf8')

    const out = await installSkillRuntime({
      homedirOverride: () => home,
      sourcePathOverride: source,
    })

    expect(out.data.overwritten).toBe(true)
    // Parent ~/.claude/skills/ already existed → hint omitted
    expect(out.data.hint).toBeUndefined()
    // File was overwritten
    expect(fsModule.readFileSync(target, 'utf8')).toBe(FIXTURE_BODY)
  })

  it('Test 3: parent ~/.claude/skills/ already existed → hint omitted', async () => {
    const { home, source } = makeScratch()
    writeFileSync(source, FIXTURE_BODY, 'utf8')

    // Pre-create the parent skills dir (but NOT the linear-agent subdir)
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })

    const out = await installSkillRuntime({
      homedirOverride: () => home,
      sourcePathOverride: source,
    })

    expect(out.data.hint).toBeUndefined()
    expect(out.data.overwritten).toBe(false)
  })
})

describe('installSkillRuntime — INSTALL_SKILL_BUNDLE_NOT_FOUND', () => {
  it('Test 4: source missing (ENOENT) throws BUNDLE_NOT_FOUND with expected_path', async () => {
    const { home, sourceDir } = makeScratch()
    const missing = path.join(sourceDir, 'does-not-exist.md')

    expect.assertions(4)
    try {
      await installSkillRuntime({
        homedirOverride: () => home,
        sourcePathOverride: missing,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const e = err as LinearAgentError
      expect(e.code).toBe('INSTALL_SKILL_BUNDLE_NOT_FOUND')
      expect(e.transient).toBe(false)
      expect(e.details?.expected_path).toBe(missing)
    }
  })

  it('Test 5: frontmatter unparseable → BUNDLE_NOT_FOUND reason=frontmatter_invalid', async () => {
    const { home, source } = makeScratch()
    // No frontmatter markers at all
    writeFileSync(source, '# linear-agent\n\nplain body, no frontmatter\n', 'utf8')

    expect.assertions(3)
    try {
      await installSkillRuntime({
        homedirOverride: () => home,
        sourcePathOverride: source,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const e = err as LinearAgentError
      expect(e.code).toBe('INSTALL_SKILL_BUNDLE_NOT_FOUND')
      expect(e.details?.reason).toBe('frontmatter_invalid')
    }
  })

  it('Test 6: frontmatter missing metadata.version → BUNDLE_NOT_FOUND reason=version_missing', async () => {
    const { home, source } = makeScratch()
    writeFileSync(
      source,
      `---
name: linear-agent
description: no version field anywhere
---

# linear-agent
`,
      'utf8',
    )

    expect.assertions(3)
    try {
      await installSkillRuntime({
        homedirOverride: () => home,
        sourcePathOverride: source,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const e = err as LinearAgentError
      expect(e.code).toBe('INSTALL_SKILL_BUNDLE_NOT_FOUND')
      expect(e.details?.reason).toBe('version_missing')
    }
  })
})

describe('installSkillRuntime — INSTALL_SKILL_WRITE_FAILED', () => {
  it('Test 7: writeFileSync EACCES → WRITE_FAILED with errno=EACCES', async () => {
    const { home, source } = makeScratch()
    writeFileSync(source, FIXTURE_BODY, 'utf8')

    const fsOverride = {
      readFileSync: fsModule.readFileSync,
      writeFileSync: ((..._args: unknown[]) => {
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }) as typeof fsModule.writeFileSync,
      mkdirSync: fsModule.mkdirSync,
      existsSync: fsModule.existsSync,
      statSync: fsModule.statSync,
    }

    expect.assertions(4)
    try {
      await installSkillRuntime({
        homedirOverride: () => home,
        sourcePathOverride: source,
        fsOverride,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const e = err as LinearAgentError
      expect(e.code).toBe('INSTALL_SKILL_WRITE_FAILED')
      expect(e.details?.errno).toBe('EACCES')
      expect(e.details?.target).toBe(
        path.join(home, '.claude', 'skills', 'linear-agent', 'SKILL.md'),
      )
    }
  })

  it('Test 8: mkdirSync EACCES → WRITE_FAILED', async () => {
    const { home, source } = makeScratch()
    writeFileSync(source, FIXTURE_BODY, 'utf8')

    const fsOverride = {
      readFileSync: fsModule.readFileSync,
      writeFileSync: fsModule.writeFileSync,
      mkdirSync: ((..._args: unknown[]) => {
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }) as typeof fsModule.mkdirSync,
      existsSync: fsModule.existsSync,
      statSync: fsModule.statSync,
    }

    expect.assertions(3)
    try {
      await installSkillRuntime({
        homedirOverride: () => home,
        sourcePathOverride: source,
        fsOverride,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const e = err as LinearAgentError
      expect(e.code).toBe('INSTALL_SKILL_WRITE_FAILED')
      expect(e.details?.errno).toBe('EACCES')
    }
  })
})

describe('installSkillRuntime — snapshots', () => {
  beforeEach(() => {
    // Use stable filesystem paths so the snapshot is byte-stable
    rmSync(STABLE_HOME, { recursive: true, force: true })
    rmSync(STABLE_SOURCE_DIR, { recursive: true, force: true })
    mkdirSync(STABLE_HOME, { recursive: true })
    mkdirSync(STABLE_SOURCE_DIR, { recursive: true })
    writeFileSync(STABLE_SOURCE, FIXTURE_BODY, 'utf8')
  })

  it('Test 9: snapshot — success envelope', async () => {
    const out = await installSkillRuntime({
      homedirOverride: () => STABLE_HOME,
      sourcePathOverride: STABLE_SOURCE,
    })
    const env = success(out.data, { ...out.meta, command: 'install-skill' })
    expect(env).toMatchSnapshot('install-skill-success')
  })

  it('Test 10: snapshot — failure envelope INSTALL_SKILL_BUNDLE_NOT_FOUND', async () => {
    const missing = '/tmp/linear-agent-missing-bundle/SKILL.md'
    expect.assertions(2)
    try {
      await installSkillRuntime({
        homedirOverride: () => STABLE_HOME,
        sourcePathOverride: missing,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const env = failure(err as LinearAgentError, { command: 'install-skill' })
      // resolved_install_path leaks the developer's absolute install path —
      // pin its shape (string) but not its value, so the snapshot is byte-stable
      // across machines (CI runners, contributor laptops, published-tarball runs).
      expect(env).toMatchSnapshot(
        {
          error: {
            details: {
              resolved_install_path: expect.any(String),
            },
          },
        },
        'install-skill-failure-bundle-not-found',
      )
    }
  })

  it('Test 11: snapshot — failure envelope INSTALL_SKILL_WRITE_FAILED', async () => {
    const fsOverride = {
      readFileSync: fsModule.readFileSync,
      writeFileSync: ((..._args: unknown[]) => {
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }) as typeof fsModule.writeFileSync,
      mkdirSync: fsModule.mkdirSync,
      existsSync: fsModule.existsSync,
      statSync: fsModule.statSync,
    }

    expect.assertions(2)
    try {
      await installSkillRuntime({
        homedirOverride: () => STABLE_HOME,
        sourcePathOverride: STABLE_SOURCE,
        fsOverride,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(LinearAgentError)
      const env = failure(err as LinearAgentError, { command: 'install-skill' })
      expect(env).toMatchSnapshot('install-skill-failure-write-failed')
    }
  })
})
