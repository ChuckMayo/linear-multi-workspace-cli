/**
 * `install-skill` runtime — Phase 5 PLAN 05-02 Task 2, DST-06.
 *
 * Pure async function: copies the bundled `skills/linear-agent/SKILL.md` from
 * the package install path to `~/.claude/skills/linear-agent/SKILL.md`. No
 * network calls, no workspace resolution.
 *
 * Source resolution: walks two levels up from this file's directory (via
 * `import.meta.url`) and into `skills/linear-agent/SKILL.md`. Works in BOTH
 * source-checkout layouts (`src/lib/install-skill-runtime.ts` → `../../skills/...`)
 * AND published-tarball layouts (`dist/lib/install-skill-runtime.js` →
 * `../../skills/...`). The `skills/` dir sits at the package root in both.
 *
 * Target resolution: `path.join(os.homedir(), '.claude', 'skills', 'linear-agent', 'SKILL.md')`
 * — uniform across macOS, Linux, and Windows. Claude Code uses `os.homedir()`
 * everywhere; no `%APPDATA%` branching, no `~` shell expansion.
 *
 * Live-change-detection mitigation (RESEARCH §4 / Pitfall P12): If THIS
 * process created `~/.claude/skills/` (or one of its ancestors) during the
 * mkdir-p step, the envelope includes a `hint` field telling the user to
 * restart Claude Code. We derive that signal from the return value of
 * `mkdirSync({ recursive: true })` — which returns the first directory it
 * actually created — instead of an existsSync check that races with
 * concurrent installs and produces misleading hints.
 *
 * Frontmatter parsing: We parse `metadata.version` from a YAML-ish frontmatter
 * block ourselves rather than depending on `js-yaml`. Rationale: js-yaml is
 * only a transitive dev dep (via @graphql-codegen/cli) and would not be in the
 * published tarball's `node_modules`. Hand-parsing the small subset we need
 * (a string scalar at `metadata.version`) keeps the runtime self-contained
 * and the cold-start budget tight.
 *
 * Error taxonomy (per RESEARCH §11 Option A — both map to EXIT_CODES.GENERIC):
 *   - INSTALL_SKILL_BUNDLE_NOT_FOUND: source missing, frontmatter unparseable,
 *     or `metadata.version` absent. `details.expected_path` always present;
 *     `details.reason` set to 'frontmatter_invalid' or 'version_missing' when
 *     applicable.
 *   - INSTALL_SKILL_WRITE_FAILED: mkdir or writeFile threw an underlying fs
 *     error (EACCES, ENOSPC, etc.). `details.target` and `details.errno`
 *     surface the exact failure.
 *
 * Two-export pattern (S1) is satisfied by this module + `src/commands/install-skill.ts`.
 */
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LinearAgentError } from '@/core/errors/index.js'
import type { Meta } from '@/core/output/index.js'

// `dirname(fileURLToPath(import.meta.url))` resolves to the directory containing
// THIS module. In dev that's `src/lib/`, in the published tarball it's `dist/lib/`.
// Both layouts have `skills/linear-agent/SKILL.md` two levels up.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE = path.resolve(HERE, '..', '..', 'skills', 'linear-agent', 'SKILL.md')

const HINT_PARENT_CREATED = 'Restart Claude Code if your session predates ~/.claude/skills/.'

// biome-ignore lint/suspicious/noEmptyInterface: reserved for future flag additions
export interface InstallSkillFlags {
  // v1 has no flags. Empty interface kept for API stability so callers can
  // `Partial<InstallSkillFlags>` once we add (e.g.) `--target` in v2.
}

export interface FsOverride {
  readFileSync: typeof fs.readFileSync
  writeFileSync: typeof fs.writeFileSync
  mkdirSync: typeof fs.mkdirSync
  existsSync: typeof fs.existsSync
  statSync: typeof fs.statSync
}

export interface InstallSkillInput {
  flags?: InstallSkillFlags
  env?: NodeJS.ProcessEnv

  /** Test seam — defaults to `() => os.homedir()`. */
  homedirOverride?: () => string
  /** Test seam — defaults to the import.meta.url-resolved bundle path. */
  sourcePathOverride?: string
  /** Test seam — inject mock fs functions to avoid touching real homedir. */
  fsOverride?: FsOverride
}

export interface InstallSkillData {
  /** Absolute path of the bundled SKILL.md that was read. */
  source: string
  /** Absolute path that was written (or would have been written if unchanged). */
  target: string
  /**
   * Bytes actually written to disk. Zero when `unchanged: true` — we did
   * not touch the file because it was already byte-identical to the source.
   */
  bytes_written: number
  /** Pulled from frontmatter `metadata.version` of the bundled SKILL.md. */
  version: string
  /** True if the target file already existed before write. */
  overwritten: boolean
  /**
   * True when the existing target was byte-identical to the source bundle
   * and the write was skipped (mtime preserved). Mutually exclusive with
   * `overwritten: true`-and-bytes-written: when this is true, no write
   * occurred. Repeated `linear-agent install-skill` invocations after a
   * version bump will set `unchanged: true` from the second call onward.
   */
  unchanged?: boolean
  /** Present only when `~/.claude/skills/` was just created. */
  hint?: string
}

export interface InstallSkillOutput {
  data: InstallSkillData
  /** `meta.command` is injected by `runCommand` in production. */
  meta: Omit<Meta, 'command'>
}

export async function installSkillRuntime(input?: InstallSkillInput): Promise<InstallSkillOutput> {
  const sourcePath = input?.sourcePathOverride ?? DEFAULT_SOURCE
  const home = (input?.homedirOverride ?? homedir)()
  const fsx: FsOverride = input?.fsOverride ?? {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
  }

  const targetDir = path.join(home, '.claude', 'skills', 'linear-agent')
  const target = path.join(targetDir, 'SKILL.md')
  const parentSkillsDir = path.join(home, '.claude', 'skills')

  // 1. Read source (bundle).
  let contents: string
  try {
    contents = fsx.readFileSync(sourcePath, 'utf8') as string
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN'
    throw new LinearAgentError({
      code: 'INSTALL_SKILL_BUNDLE_NOT_FOUND',
      message: `Could not locate bundled SKILL.md at ${sourcePath}. This usually means linear-agent was run from a source checkout without a build, or the published tarball is corrupt.`,
      transient: false,
      details: {
        expected_path: sourcePath,
        resolved_install_path: HERE,
        errno,
      },
    })
  }

  // 2. Parse frontmatter and pull metadata.version.
  const version = extractMetadataVersion(contents, sourcePath)

  // 3. Capture overwrite state BEFORE we write.
  const overwritten = fsx.existsSync(target)

  // 4. mkdir -p targetDir.
  //
  // Live-change-detection (RESEARCH §4 / Pitfall P12) used to be implemented
  // with an existsSync(parentSkillsDir) check BEFORE mkdir, then comparing
  // after the fact. That had a TOCTOU race: a concurrent install (or Claude
  // Code itself initializing ~/.claude/skills/) could create the parent
  // between the check and the mkdir, producing a misleading hint. Use
  // mkdirSync({ recursive: true })'s return value instead — Node 14+
  // returns the FIRST directory it had to create (undefined if no creation
  // happened). If that first-created path is at or above the parent
  // skills dir, we know the parent was just created by THIS process.
  let parentSkillsCreatedNow = false
  try {
    const created = fsx.mkdirSync(targetDir, { recursive: true })
    if (typeof created === 'string') {
      // `created` is the first directory created. If it's the parent
      // skills dir itself, or an ancestor of it (e.g., ~/.claude was
      // missing), then this process just created the parent.
      const createdResolved = path.resolve(created)
      const parentResolved = path.resolve(parentSkillsDir)
      parentSkillsCreatedNow =
        createdResolved === parentResolved ||
        parentResolved.startsWith(`${createdResolved}${path.sep}`)
    }
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN'
    throw new LinearAgentError({
      code: 'INSTALL_SKILL_WRITE_FAILED',
      message: `Could not write SKILL.md to ${target}. Check directory permissions.`,
      transient: false,
      details: { target, errno },
    })
  }

  // 5. Write target — but skip the write when the existing file is
  //    byte-identical to the source. install-skill is the canonical
  //    post-version-bump re-install path; agents and users will run it
  //    repeatedly. Skipping no-op writes (a) avoids touching mtime —
  //    Claude Code's skill-cache uses mtime as a staleness signal — and
  //    (b) makes the envelope's `unchanged: true` an unambiguous "your
  //    on-disk bundle already matches the source" signal.
  let unchanged = false
  if (overwritten) {
    let existing: string | undefined
    try {
      existing = fsx.readFileSync(target, 'utf8') as string
    } catch {
      // If the read fails (race, permission, etc.), fall through to the
      // unconditional write — that's strictly safer than skipping.
      existing = undefined
    }
    if (existing === contents) {
      unchanged = true
    }
  }

  if (!unchanged) {
    try {
      fsx.writeFileSync(target, contents, 'utf8')
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN'
      throw new LinearAgentError({
        code: 'INSTALL_SKILL_WRITE_FAILED',
        message: `Could not write SKILL.md to ${target}. Check directory permissions.`,
        transient: false,
        details: { target, errno },
      })
    }
  }

  // 6. Build envelope data. `hint` only present when the parent dir was
  //    just created (live-change-detection mitigation).
  const data: InstallSkillData = {
    source: sourcePath,
    target,
    bytes_written: unchanged ? 0 : Buffer.byteLength(contents, 'utf8'),
    version,
    overwritten,
  }
  if (unchanged) {
    data.unchanged = true
  }
  if (parentSkillsCreatedNow) {
    data.hint = HINT_PARENT_CREATED
  }

  return { data, meta: {} }
}

/**
 * Extract the `metadata.version` field from a SKILL.md's YAML frontmatter.
 *
 * We hand-parse rather than pull in js-yaml because js-yaml is a transitive
 * dev dep only (via @graphql-codegen/cli) and would not be present in the
 * published tarball. Our SKILL.md is authored in-repo, so the frontmatter
 * shape is fully under our control:
 *
 *     ---
 *     name: linear-agent
 *     description: ...
 *     metadata:
 *       version: "0.1.0"
 *     ---
 *
 * This parser handles:
 *   - quoted (single OR double) and unquoted version strings
 *   - any indentation level under `metadata:` (we look for the first
 *     `version:` line that follows a `metadata:` line)
 *
 * Failure modes (both surface as INSTALL_SKILL_BUNDLE_NOT_FOUND):
 *   - No frontmatter markers at all → reason='frontmatter_invalid'
 *   - Frontmatter present but no `metadata.version` → reason='version_missing'
 */
function extractMetadataVersion(contents: string, sourcePath: string): string {
  // Frontmatter must start with `---` on the first line and have a closing
  // `---` later. Tolerate a leading BOM and trailing whitespace on markers.
  const stripped = contents.replace(/^﻿/, '')
  const lines = stripped.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new LinearAgentError({
      code: 'INSTALL_SKILL_BUNDLE_NOT_FOUND',
      message: `Could not parse YAML frontmatter from ${sourcePath} — missing leading '---' marker.`,
      transient: false,
      details: { expected_path: sourcePath, reason: 'frontmatter_invalid' },
    })
  }
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) {
    throw new LinearAgentError({
      code: 'INSTALL_SKILL_BUNDLE_NOT_FOUND',
      message: `Could not parse YAML frontmatter from ${sourcePath} — missing closing '---' marker.`,
      transient: false,
      details: { expected_path: sourcePath, reason: 'frontmatter_invalid' },
    })
  }

  const frontmatter = lines.slice(1, endIdx)
  // Find the `metadata:` key and the first `version:` indented under it.
  let inMetadata = false
  let metadataIndent = -1
  let version: string | undefined
  for (const line of frontmatter) {
    if (/^metadata\s*:\s*$/.test(line)) {
      inMetadata = true
      metadataIndent = line.length - line.trimStart().length
      continue
    }
    if (inMetadata) {
      // Empty/comment lines are skipped without exiting the block.
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const lineIndent = line.length - line.trimStart().length
      // A non-indented line ends the metadata block.
      if (lineIndent <= metadataIndent) {
        inMetadata = false
        // re-evaluate this line at the top level — but since we only care
        // about metadata.version, we simply stop searching.
        break
      }
      const m = line.match(/^\s*version\s*:\s*(.+?)\s*$/)
      if (m?.[1]) {
        let raw = m[1]
        // Strip matched surrounding quotes (single or double).
        if (
          (raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'"))
        ) {
          raw = raw.slice(1, -1)
        }
        version = raw
        break
      }
    }
  }

  if (!version) {
    throw new LinearAgentError({
      code: 'INSTALL_SKILL_BUNDLE_NOT_FOUND',
      message: `Bundled SKILL.md at ${sourcePath} has no metadata.version field in its frontmatter.`,
      transient: false,
      details: { expected_path: sourcePath, reason: 'version_missing' },
    })
  }
  return version
}
