#!/usr/bin/env node
/**
 * verify-pack.mjs — Single source of truth for the published-tarball contract.
 *
 * Runs `npm pack --dry-run --json`, parses the file list, and asserts:
 *   - Allowlist: every required path prefix is present (bin/, dist/,
 *     schema.graphql, src/generated/, README.md, package.json, and the
 *     stamped Phase-5 skill bundle skills/linear-agent/SKILL.md)
 *   - Denylist: no forbidden path patterns appear (node_modules, src/*.ts except
 *     src/generated/, test/, codegen/, .planning/, .github/, dotfiles, *.tgz, etc.)
 *   - Runtime deps allowlist: @oclif/core, @linear/sdk, zod, conf, picocolors,
 *     @graphql-typed-document-node/core all in package.json#dependencies
 *   - Runtime deps denylist: oclif devkit, @aws-sdk/*, tsup, chalk, commander,
 *     graphql-request, dotenv, keytar, eslint, prettier, zod-to-json-schema must
 *     NOT be in package.json#dependencies
 *   - Strict: oclif devkit must live in devDependencies
 *
 * Exits 0 with a summary on success, 1 with the violation list + full file list
 * on failure. Both vitest (test/pack.test.ts) and CI (.github/workflows/ci.yml)
 * invoke this script unmodified — keep it that way so the contract has one home.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED_PREFIXES = [
  'bin/',
  'dist/',
  'schema.graphql',
  'src/generated/',
  'README.md',
  'package.json',
  // Phase 5 DST-05: the stamped Claude Code skill bundle. The .tmpl is
  // checked in but excluded from the published tarball; the prepack pipeline
  // produces SKILL.md from the template. If this prefix isn't in the pack,
  // the skill never reaches users.
  'skills/linear-agent/SKILL.md',
]

const FORBIDDEN_PATTERNS = [
  /^node_modules\//,
  /(?:^|\/)@aws-sdk\//,
  /(?:^|\/)oclif\/dist\//, // the devkit's runtime path; @oclif/core is fine
  /^src\/(?!generated\/)/, // any src/ except src/generated/
  /^test\//,
  /^codegen\//,
  /^codegen\.ts$/,
  /^\.github\//,
  /^\.planning\//,
  /^scripts\//,
  /^coverage\//,
  /^tsconfig\.json$/,
  /^biome\.json$/,
  /^vitest\.config\.ts$/,
  /^tsdown\.config\.ts$/,
  /^\.env/,
  /\.tgz$/,
  /^\.DS_Store$/,
  // Phase 5 DST-05: only the stamped SKILL.md ships; the .tmpl source is
  // a build input, not a publishable artifact.
  /\.tmpl$/,
]

const REQUIRED_RUNTIME_DEPS = [
  '@graphql-typed-document-node/core',
  '@linear/sdk',
  '@oclif/core',
  'conf',
  'graphql',
  'picocolors',
  'zod',
]

const FORBIDDEN_RUNTIME_DEPS = [
  'oclif',
  '@aws-sdk/client-s3',
  'tsup',
  'chalk',
  'commander',
  'graphql-request',
  'dotenv',
  'keytar',
  'node-keytar',
  'eslint',
  'prettier',
  'zod-to-json-schema',
]

/**
 * Extract the trailing JSON array from npm pack's stdout. npm's lifecycle
 * scripts (prepack -> build, postpack -> rm manifest) write their own output
 * to stdout, so the JSON we want is at the END of the buffer. Strategy:
 *   1) Try parsing the whole buffer (works if no lifecycle output).
 *   2) Find the last opening `[` and try to parse from there to the end.
 *   3) Walk character-by-character from each `[` looking for a balanced array.
 */
function extractJsonArray(stdout) {
  const trimmed = stdout.trim()
  // Fast path: stdout is pure JSON.
  try {
    return JSON.parse(trimmed)
  } catch {}

  // Find the trailing `]` and walk back to the matching `[`.
  const lastClose = trimmed.lastIndexOf(']')
  if (lastClose === -1) {
    throw new Error('npm pack --dry-run --json output contained no JSON array')
  }
  for (let i = trimmed.lastIndexOf('[', lastClose); i !== -1; i = trimmed.lastIndexOf('[', i - 1)) {
    const candidate = trimmed.slice(i, lastClose + 1)
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }
  throw new Error('Could not locate a parseable JSON array in npm pack output')
}

/**
 * Parse the human-readable `npm pack --dry-run` fallback output. Used when
 * `--json` is not supported (npm < 7). The lines we want sit between
 * "Tarball Contents" and "Tarball Details", each formatted like
 * `<size>  <path>` with leading whitespace.
 */
function parseHumanReadablePackOutput(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /Tarball Contents/i.test(l))
  if (start === -1) {
    throw new Error('Fallback parser could not find "Tarball Contents" section')
  }
  const files = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (/^\s*$/.test(line)) break
    if (/Tarball Details/i.test(line)) break
    // Format example: "  npm notice 1.4kB  README.md"
    const match = line.match(/\s+([\d.]+\s*[a-zA-Z]*)\s+(.+?)\s*$/)
    if (match?.[2]) files.push({ path: match[2] })
  }
  if (files.length === 0) {
    throw new Error('Fallback parser found "Tarball Contents" but extracted no files')
  }
  return [{ files, size: 0 }]
}

function packDryRun() {
  // First try `npm pack --dry-run --json --ignore-scripts`. npm 7+ supports it.
  // `--ignore-scripts` skips prepack/postpack so the dry-run reflects ONLY the
  // current on-disk state — i.e., it checks that whoever invoked verify-pack
  // already produced the build + stamped artifacts. Without this flag the
  // dry-run would silently re-run prepack and mask a broken pipeline.
  let stdout
  try {
    stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    throw new Error(`npm pack --dry-run --json failed to execute: ${err.message ?? err}`)
  }

  try {
    const parsed = extractJsonArray(stdout)
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error(`Expected one packed package, got ${parsed.length ?? 'non-array'}`)
    }
    return parsed[0]
  } catch (jsonErr) {
    // Fallback to human-readable parsing. Re-run without --json so npm emits the table.
    const text = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const fallback = parseHumanReadablePackOutput(text)
    process.stderr.write(
      `note: npm pack --dry-run --json output unparseable (${jsonErr.message}); using fallback parser\n`,
    )
    return fallback[0]
  }
}

function main() {
  const errors = []

  const pkg = packDryRun()
  const paths = (pkg.files ?? []).map((f) => f.path)

  for (const prefix of REQUIRED_PREFIXES) {
    if (!paths.some((p) => p === prefix || p.startsWith(prefix))) {
      errors.push(`MISSING REQUIRED: ${prefix}`)
    }
  }
  for (const p of paths) {
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(p)) {
        errors.push(`FORBIDDEN PATH: ${p} matched ${pat}`)
      }
    }
  }

  const pjson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  const deps = pjson.dependencies ?? {}
  const devDeps = pjson.devDependencies ?? {}

  for (const d of REQUIRED_RUNTIME_DEPS) {
    if (!deps[d]) errors.push(`MISSING RUNTIME DEP: ${d}`)
  }
  for (const d of FORBIDDEN_RUNTIME_DEPS) {
    if (deps[d]) errors.push(`FORBIDDEN RUNTIME DEP (must be devDep or absent): ${d}`)
  }
  if (!devDeps.oclif) errors.push('oclif devkit must be in devDependencies (release tooling only)')

  // Bundle size is informational in Phase 0; Phase 5 enforces a 5 MB ceiling.
  const sizeBytes = pkg.unpackedSize ?? pkg.size ?? 0
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2)

  if (errors.length === 0) {
    process.stdout.write('✓ pack contract verified\n')
    process.stdout.write(`  files in tarball: ${paths.length}\n`)
    process.stdout.write(`  unpacked size:    ${sizeMb} MB\n`)
    process.stdout.write(
      `  runtime deps:     ${Object.keys(deps).length} (${REQUIRED_RUNTIME_DEPS.length} required)\n`,
    )
    process.exit(0)
  }

  process.stderr.write('✗ pack contract violated:\n')
  for (const e of errors) process.stderr.write(`  - ${e}\n`)
  process.stderr.write('\nFile list:\n')
  for (const p of paths) process.stderr.write(`  ${p}\n`)
  process.exit(1)
}

main()
