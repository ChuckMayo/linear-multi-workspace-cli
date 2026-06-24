#!/usr/bin/env node
/**
 * verify-pack.mjs — Single source of truth for the published-tarball contract.
 *
 * Runs `npm pack --dry-run --json`, parses the file list, and asserts:
 *   - Allowlist: every required path prefix is present (bin/, dist/,
 *     schema.graphql, src/generated/, README.md, package.json, and the
 *     stamped Phase-5 skill bundle skills/linmux/SKILL.md)
 *   - Denylist: no forbidden path patterns appear (node_modules, src/*.ts except
 *     src/generated/, test/, codegen/, .planning/, .github/, dotfiles, *.tgz, etc.)
 *   - Runtime deps allowlist: @oclif/core, @linear/sdk, zod, conf, picocolors,
 *     @graphql-typed-document-node/core all in package.json#dependencies
 *   - Runtime deps denylist: oclif devkit, @aws-sdk/*, tsup, chalk, commander,
 *     graphql-request, dotenv, keytar, eslint, prettier, zod-to-json-schema must
 *     NOT be in package.json#dependencies
 *   - Strict: oclif devkit must live in devDependencies
 *   - Phase-5 DST-04: pkg.unpackedSize <= 5 MB. On violation, the top-10
 *     largest files in the tarball are emitted to stderr so the dev knows
 *     what to evict.
 *
 * Exits 0 with a summary on success, 1 with the violation list + full file list
 * on failure. Both vitest (test/pack.test.ts) and CI (.github/workflows/ci.yml)
 * invoke this script unmodified — keep it that way so the contract has one home.
 *
 * Library mode: tests `import { findViolations, topNLargest, SIZE_BUDGET_BYTES }`
 * to unit-test the assertion logic against synthetic pkg objects without
 * actually running `npm pack`. The CLI entrypoint runs only when this file is
 * invoked directly via `node scripts/verify-pack.mjs`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_PREFIXES = [
  'bin/',
  'dist/',
  'schema.graphql',
  'README.md',
  'package.json',
  // Phase 5 DST-05: the stamped Claude Code skill bundle. The .tmpl is
  // checked in but excluded from the published tarball; the prepack pipeline
  // produces SKILL.md from the template. If this prefix isn't in the pack,
  // the skill never reaches users.
  'skills/linmux/SKILL.md',
]

export const FORBIDDEN_PATTERNS = [
  /^node_modules\//,
  /(?:^|\/)@aws-sdk\//,
  /(?:^|\/)oclif\/dist\//, // the devkit's runtime path; @oclif/core is fine
  /^src\//, // no src/ ships — dist/ has the compiled output, src/generated dropped to fit DST-04 5MB budget
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

export const REQUIRED_RUNTIME_DEPS = [
  '@graphql-typed-document-node/core',
  '@linear/sdk',
  '@oclif/core',
  'conf',
  'graphql',
  'picocolors',
  'zod',
]

export const FORBIDDEN_RUNTIME_DEPS = [
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
 * Phase 5 DST-04 release-blocking budget: the unpacked tarball must fit
 * under 5 MB. We use the unpacked size (not the gzipped `size`) because
 * that's what hits user disks via `npx -y` and matters for cold-start.
 *
 * Why 5 MB: PROJECT.md / CLAUDE.md set this as a hard ceiling for the
 * "any agent that can shell out" promise. A 50 MB bundle would tank `npx`
 * cold-start on slow networks.
 */
export const SIZE_BUDGET_BYTES = 5_000_000

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

function packDryRun() {
  // `npm pack --dry-run --json --ignore-scripts` requires npm 7+, which
  // ships with Node 16+. Our `engines.node` floor is 22, which ships npm
  // 10+, so JSON output is guaranteed.
  //
  // `--ignore-scripts` skips prepack/postpack so the dry-run reflects ONLY
  // the current on-disk state — i.e., it checks that whoever invoked
  // verify-pack already produced the build + stamped artifacts. Without
  // this flag the dry-run would silently re-run prepack and mask a broken
  // pipeline.
  //
  // We deliberately do NOT keep a human-readable fallback parser. The
  // previous fallback returned `size: 0` on parse failure, which silently
  // bypassed the DST-04 5MB unpacked-size budget — a worse failure mode
  // than just exiting 1. Any future npm JSON-shape regression should
  // surface as a hard error so the maintainer fixes verify-pack, not as
  // a silent budget bypass.
  let stdout
  try {
    stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    throw new Error(`npm pack --dry-run --json failed to execute: ${err.message ?? err}`)
  }

  const parsed = extractJsonArray(stdout)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Expected one packed package, got ${parsed.length ?? 'non-array'}`)
  }
  return parsed[0]
}

/**
 * Pure-logic violation finder. Takes the parsed `npm pack --dry-run --json`
 * output (the `pkg` object) and the parsed `package.json`, returns an array
 * of violation strings. Used by both `main()` (CLI) and the unit tests.
 *
 * Order of checks: allowlist → denylist → deps → size. We don't short-circuit
 * — every violation is reported in one pass so the dev sees the full picture.
 */
export function findViolations({ pkg, packageJson }) {
  const errors = []
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

  const deps = packageJson.dependencies ?? {}
  const devDeps = packageJson.devDependencies ?? {}

  for (const d of REQUIRED_RUNTIME_DEPS) {
    if (!deps[d]) errors.push(`MISSING RUNTIME DEP: ${d}`)
  }
  for (const d of FORBIDDEN_RUNTIME_DEPS) {
    if (deps[d]) errors.push(`FORBIDDEN RUNTIME DEP (must be devDep or absent): ${d}`)
  }
  if (!devDeps.oclif) {
    errors.push('oclif devkit must be in devDependencies (release tooling only)')
  }

  // Phase 5 DST-04: hard size budget. unpackedSize is the on-disk footprint
  // after `npm install` extracts the tarball; that's what `npx --yes` pays
  // for on every cold start.
  const unpackedSize = pkg.unpackedSize ?? pkg.size ?? 0
  if (unpackedSize > SIZE_BUDGET_BYTES) {
    const sizeMB = (unpackedSize / 1024 / 1024).toFixed(2)
    const budgetMB = (SIZE_BUDGET_BYTES / 1024 / 1024).toFixed(0)
    errors.push(`SIZE BUDGET EXCEEDED: ${sizeMB} MB > ${budgetMB} MB`)
  }

  return errors
}

/**
 * Return the N largest entries from `pkg.files`, sorted by size descending.
 * Treats missing `size` as 0. Does not mutate the input. If `files` has
 * fewer than N entries, returns all of them sorted.
 */
export function topNLargest(files, n = 10) {
  return [...files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, n)
}

/**
 * Preconditions for `--ignore-scripts` mode (which is what we always use):
 * the prepack lifecycle is intentionally NOT executed, so the build output
 * (dist/) AND the stamped Phase-5 skill bundle (skills/linmux/SKILL.md)
 * must already exist on disk. Without this guard, a developer running
 * `node scripts/verify-pack.mjs` without first running `npm run build` and
 * `node scripts/stamp-skill.mjs` would see a misleading MISSING REQUIRED
 * violation instead of an actionable "you skipped the prepack steps"
 * message — silently diverging from what `npm publish` will actually pack.
 */
function assertPrepackArtifacts() {
  const cwd = process.cwd()
  const stampedSkill = resolve(cwd, 'skills/linmux/SKILL.md')
  // tsdown's `unbundle: true` config emits per-file outputs under dist/ —
  // dist/commands/ is the load-bearing directory the published `main`
  // and oclif manifest both reference, so its presence is the cheapest
  // signal that `npm run build` has run.
  const distCommands = resolve(cwd, 'dist/commands')
  const missing = []
  if (!existsSync(distCommands)) missing.push('dist/commands/ (run `npm run build`)')
  if (!existsSync(stampedSkill)) {
    missing.push('skills/linmux/SKILL.md (run `node scripts/stamp-skill.mjs`)')
  }
  if (missing.length > 0) {
    process.stderr.write(
      'verify-pack: prepack artifacts missing — verify-pack runs npm pack with\n' +
        '--ignore-scripts (so the prepack lifecycle is NOT executed), and the\n' +
        'following on-disk artifacts must already exist:\n',
    )
    for (const m of missing) process.stderr.write(`  - ${m}\n`)
    process.stderr.write(
      '\nFix: run `npm run build && node scripts/stamp-skill.mjs` before this\n' +
        'script, or invoke verify-pack via `npm pack` so prepack runs.\n',
    )
    process.exit(1)
  }
}

function main() {
  assertPrepackArtifacts()
  const pkg = packDryRun()
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  const errors = findViolations({ pkg, packageJson })
  const paths = (pkg.files ?? []).map((f) => f.path)

  // Bundle size is informational on success; DST-04 enforces a 5 MB ceiling.
  const sizeBytes = pkg.unpackedSize ?? pkg.size ?? 0
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2)

  if (errors.length === 0) {
    process.stdout.write('✓ pack contract verified\n')
    process.stdout.write(`  files in tarball: ${paths.length}\n`)
    process.stdout.write(`  unpacked size:    ${sizeMb} MB (budget: 5.00 MB)\n`)
    process.stdout.write(
      `  runtime deps:     ${Object.keys(packageJson.dependencies ?? {}).length} (${REQUIRED_RUNTIME_DEPS.length} required)\n`,
    )
    process.exit(0)
  }

  process.stderr.write('✗ pack contract violated:\n')
  for (const e of errors) process.stderr.write(`  - ${e}\n`)

  // DST-04 diagnostic: when the size budget is the (or one) reason for
  // failure, print the top-10 largest files so the dev knows what to evict.
  if (errors.some((e) => e.startsWith('SIZE BUDGET'))) {
    process.stderr.write('\nTop 10 largest files in tarball:\n')
    const top = topNLargest(pkg.files ?? [], 10)
    for (const f of top) {
      const kb = ((f.size ?? 0) / 1024).toFixed(1).padStart(10)
      process.stderr.write(`  ${kb} KB  ${f.path}\n`)
    }
  }

  process.stderr.write('\nFile list:\n')
  for (const p of paths) process.stderr.write(`  ${p}\n`)
  process.exit(1)
}

// Run as CLI when invoked directly; library when imported (tests).
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main()
}
