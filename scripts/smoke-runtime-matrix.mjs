#!/usr/bin/env node
/**
 * smoke-runtime-matrix.mjs — Cross-runtime smoke matrix for `linear-agent`.
 *
 * Phase 5 PLAN 05-04 — DST-02 + DST-07. Same script invoked locally and from
 * release.yml's matrix; eliminates "works locally, fails in CI" drift.
 *
 * Lanes:
 *   - plain-bash             (release-blocking) — `npx --yes file:./<tarball> me --json`
 *   - claude-code-via-skill  (release-blocking) — extracts the literal `npx -y linear-agent@<v>`
 *                             from the stamped SKILL.md and runs the equivalent local invocation;
 *                             asserts skill version == package.json#version (proves stamp ran)
 *   - codex-cli-via-exec     (advisory)         — `npx --yes @openai/codex@... exec ...` (RESEARCH §5)
 *   - gemini-cli-via-exec    (advisory)         — `npx --yes @google/gemini-cli@... -p ... --output-format json`
 *
 * Usage:
 *   node scripts/smoke-runtime-matrix.mjs --lane=<lane> [--tarball=./linear-agent-X.Y.Z.tgz] [--skill-path=./skills/linear-agent/SKILL.md]
 *   # lane ∈ { plain-bash, claude-code-via-skill, codex-cli-via-exec, gemini-cli-via-exec, all }
 *
 * Stdout: a single JSON line per invocation. For --lane=all, an aggregate object with `lanes: [...]`.
 * Exit codes: 0 if no release-blocking lane returned ok:false; 1 otherwise.
 *
 * Hard rules:
 *   - SAFE-API: every subprocess call uses `spawnSync` with an arg array. NEVER `exec` / shell strings.
 *     This ensures `--tarball=` and skill-extracted version strings cannot be shell-interpolated.
 *   - SECRET REDACTION (RESEARCH §10 P10 / §14): captured stdout/stderr from advisory lanes is
 *     scrubbed of `LINEAR_TEST_API_KEY`, `CODEX_TEST_API_KEY`, `GEMINI_TEST_API_KEY`,
 *     `LINEAR_API_KEY` literal values via `.split().join()` before being included in any output.
 *   - VERSION PINS (RESEARCH §10 P11): codex/gemini CLI versions live in `RUNTIME_PINS`. v1
 *     uses `@latest` for advisory lanes; tighten to a SHA-pinned tag once promoted to blocking.
 *   - ADVISORY LANES SKIP CLEANLY when their API-key env var is absent or empty. Release-blocking
 *     lanes MUST exit 1 hard on any failure.
 */
import { spawnSync as realSpawnSync } from 'node:child_process'
import { readFileSync as realReadFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────── Lane registry ───────────────────────────

export const LANES = Object.freeze({
  'plain-bash': Object.freeze({ blocking: true, requires: Object.freeze([]) }),
  'claude-code-via-skill': Object.freeze({ blocking: true, requires: Object.freeze([]) }),
  'codex-cli-via-exec': Object.freeze({
    blocking: false,
    requires: Object.freeze(['CODEX_TEST_API_KEY']),
  }),
  'gemini-cli-via-exec': Object.freeze({
    blocking: false,
    requires: Object.freeze(['GEMINI_TEST_API_KEY']),
  }),
})

export const RUNTIME_PINS = Object.freeze({
  // v1: tracking @latest is acceptable because these are advisory lanes.
  // Phase 6 promotes them to blocking and pins to a SHA-tagged release per RESEARCH §10 P11.
  codex: '@openai/codex@latest',
  gemini: '@google/gemini-cli@latest',
})

// Env var names whose values must NOT leak into script output.
const SECRET_ENV_VARS = Object.freeze([
  'LINEAR_TEST_API_KEY',
  'CODEX_TEST_API_KEY',
  'GEMINI_TEST_API_KEY',
  'LINEAR_API_KEY',
])

// ─────────────────────────── Pure helpers ───────────────────────────

/**
 * Strip known secret env values from a string. Uses `.split().join()` instead of
 * a regex replace because secret values can contain regex metacharacters
 * (`$`, `.`, `\`, etc.) that would otherwise be misinterpreted.
 *
 * Invariants:
 *   - Falsy input (null, undefined, '') is returned unchanged. The function
 *     is a no-op when there is nothing to redact.
 *   - Only secrets of length >= 8 are redacted. This is an INTENTIONAL
 *     false-positive guard: a real Linear personal API key is `lin_api_<32+
 *     chars>` (well above 8), so any configured secret of length < 8 is by
 *     definition NOT a real key and is almost certainly a placeholder
 *     ("test", "key", "abc") that would over-redact common substrings in
 *     captured stdout. The trade-off: a developer who deliberately
 *     configures a short test key (e.g., `LINEAR_TEST_API_KEY=test`) for
 *     local debugging will see that value survive into captured output.
 *     This is a debug-time concession, not a production threat.
 *
 * @param {string|undefined|null} text
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns the input with each known secret value replaced by '[REDACTED]'
 */
export function redact(text, env = process.env) {
  if (!text) return text
  let out = String(text)
  for (const name of SECRET_ENV_VARS) {
    const value = env[name]
    // Only redact non-empty secrets of length >= 8. See docstring "Invariants"
    // for why short values are intentionally passed through unredacted.
    if (typeof value === 'string' && value.length >= 8) {
      out = out.split(value).join('[REDACTED]')
    }
  }
  return out
}

/**
 * Parse `--lane=`, `--tarball=`, `--skill-path=` from argv. Records unknown
 * flags in `_unknownFlags` so the caller can decide how to handle them.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    lane: undefined,
    tarball: undefined,
    skillPath: undefined,
    _unknownFlags: [],
  }
  for (const arg of argv) {
    if (arg.startsWith('--lane=')) out.lane = arg.slice('--lane='.length)
    else if (arg.startsWith('--tarball=')) out.tarball = arg.slice('--tarball='.length)
    else if (arg.startsWith('--skill-path=')) out.skillPath = arg.slice('--skill-path='.length)
    else if (arg === '--help' || arg === '-h') out._help = true
    else out._unknownFlags.push(arg)
  }
  return out
}

/**
 * Extract the first JSON object from stdout that has a `$apiVersion` discriminator
 * (i.e., our envelope). Tolerates oclif's secondary `{ "error": { "code": "EEXIT" } }`
 * wrapper that gets emitted on non-zero exits.
 *
 * Strategy: try the trimmed full buffer first (fast path). If multi-object,
 * walk JSON-prefix candidates from each `{` until one parses with `$apiVersion`.
 *
 * @param {string} stdout
 * @returns the parsed envelope, or null if none found
 */
export function parseEnvelopeFromStdout(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null
  // Fast path: stdout is one JSON object.
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && '$apiVersion' in parsed) {
      return parsed
    }
  } catch {
    /* multi-object output; fall through */
  }
  // Slow path: walk each `{` and try increasing-length prefixes until one parses.
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '{') continue
    // Use balanced-bracket scan to find the matching `}`.
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < trimmed.length; j++) {
      const ch = trimmed[j]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(i, j + 1)
          try {
            const parsed = JSON.parse(candidate)
            if (parsed && typeof parsed === 'object' && '$apiVersion' in parsed) {
              return parsed
            }
          } catch {
            /* keep walking */
          }
          break
        }
      }
    }
  }
  return null
}

/**
 * Auto-discover the packed tarball in cwd. Mirrors the convention used by
 * `measure-cold-start.mjs`. Falls back to null if no match found.
 *
 * @param {string} cwd
 */
export function findTarball(cwd) {
  try {
    const entries = readdirSync(cwd)
    const matches = entries.filter((f) => /^linear-agent-.*\.tgz$/.test(f)).sort()
    if (matches.length === 0) return null
    // Last match (lexicographic) is typically the most recent version.
    return resolve(cwd, matches[matches.length - 1])
  } catch {
    return null
  }
}

// ─────────────────────────── Lane implementations ───────────────────────────

/**
 * `plain-bash` lane. Spawns `npx --yes file:./<tarball> me --json` and asserts
 * the envelope. Either success-with-key OR no-key-WORKSPACE_NOT_RESOLVED is
 * acceptable — both prove the CLI is reachable and the envelope contract holds.
 */
function runPlainBashLane({ tarball, spawnImpl, env }) {
  const result = spawnImpl('npx', ['--yes', `file:${tarball}`, 'me', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...env, LINEAR_API_KEY: env.LINEAR_TEST_API_KEY ?? '' },
    timeout: 60_000,
  })
  if (result.status === null) {
    return {
      ok: false,
      lane: 'plain-bash',
      reason: redact(`spawn signal: ${result.signal}`, env),
    }
  }
  // The CLI may emit two JSON objects on non-zero exit: our envelope first,
  // then oclif's `{ "error": { "code": "EEXIT", ... } }` wrapper. Take the
  // first parseable JSON object whose shape matches our envelope ($apiVersion
  // is the discriminator).
  let parsed = parseEnvelopeFromStdout(String(result.stdout ?? ''))
  if (!parsed) {
    const sample = redact(String(result.stdout ?? '').slice(0, 200), env)
    return {
      ok: false,
      lane: 'plain-bash',
      reason: `unparseable stdout (status=${result.status}): ${sample}`,
    }
  }
  if (parsed.$apiVersion !== '1') {
    return {
      ok: false,
      lane: 'plain-bash',
      reason: `bad $apiVersion: ${redact(String(parsed.$apiVersion), env)}`,
    }
  }
  const okWithKey =
    parsed.ok === true &&
    parsed.data != null &&
    parsed.data.user != null &&
    typeof parsed.data.user.id === 'string'
  const okNoKey = parsed.ok === false && parsed.error?.code === 'WORKSPACE_NOT_RESOLVED'
  if (!okWithKey && !okNoKey) {
    return {
      ok: false,
      lane: 'plain-bash',
      reason: `unexpected envelope: ok=${parsed.ok}, code=${parsed.error?.code ?? 'none'}`,
    }
  }
  return { ok: true, lane: 'plain-bash', output: parsed }
}

/**
 * `claude-code-via-skill` lane. Reads the stamped SKILL.md, extracts the
 * literal `npx -y linear-agent@<version>` invocation, asserts the version
 * matches package.json#version (proves the stamp ran), then runs the
 * equivalent local invocation via `runPlainBashLane`.
 *
 * Why local instead of registry: v0.1.0 may not be published yet, so we
 * reuse plain-bash's tarball-based invocation. The lane is still meaningful
 * because it proves (a) the skill body's command literal is well-formed
 * and (b) the stamped version is consistent with package.json.
 */
function runClaudeCodeViaSkillLane({ tarball, skillPath, spawnImpl, fsImpl, env }) {
  let skillBody
  try {
    skillBody = fsImpl.readFileSync(skillPath, 'utf8')
  } catch (err) {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: `could not read skill at ${skillPath}: ${err.message ?? err}`,
    }
  }
  const match = String(skillBody).match(/npx -y linear-agent@(\S+)/)
  if (!match) {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: 'skill body has no `npx -y linear-agent@<version>` invocation',
    }
  }
  const skillVersion = match[1]
  let pkgRaw
  try {
    pkgRaw = fsImpl.readFileSync('package.json', 'utf8')
  } catch (err) {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: `could not read package.json: ${err.message ?? err}`,
    }
  }
  let pkgVersion
  try {
    pkgVersion = JSON.parse(pkgRaw).version
  } catch {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: 'package.json is not valid JSON',
    }
  }
  if (skillVersion !== pkgVersion) {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: `skill version mismatch: skill=${skillVersion}, pkg=${pkgVersion}`,
    }
  }
  // Re-use plain-bash's envelope assertions, but report under this lane name.
  const inner = runPlainBashLane({ tarball, spawnImpl, env })
  return { ...inner, lane: 'claude-code-via-skill' }
}

/**
 * Generic advisory-lane runner. Skips with `ok:true, skipped:true` when the
 * lane's required env var is absent or empty; otherwise spawns the CLI.
 */
function runAdvisoryLane({
  lane,
  spawnArgs,
  envVarName,
  spawnImpl,
  env,
}) {
  const apiKey = env[envVarName]
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return {
      ok: true,
      lane,
      skipped: true,
      reason: `${envVarName} not set`,
    }
  }
  const result = spawnImpl('npx', spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...env, LINEAR_API_KEY: env.LINEAR_TEST_API_KEY ?? '' },
    timeout: 120_000,
  })
  // Capture limited slices of stdout/stderr, redacted.
  const stdoutSlice = redact(String(result.stdout ?? '').slice(0, 5000), env)
  const stderrSlice = redact(String(result.stderr ?? '').slice(0, 2000), env)
  if (result.status === null) {
    return {
      ok: false,
      lane,
      reason: `spawn signal: ${result.signal}`,
      stderr: stderrSlice,
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      lane,
      reason: `subprocess exited ${result.status}`,
      stderr: stderrSlice,
    }
  }
  return { ok: true, lane, output: stdoutSlice }
}

function runCodexLane({ tarball, spawnImpl, env }) {
  return runAdvisoryLane({
    lane: 'codex-cli-via-exec',
    envVarName: 'CODEX_TEST_API_KEY',
    spawnArgs: [
      '--yes',
      RUNTIME_PINS.codex,
      'exec',
      '--sandbox',
      'workspace-write',
      '--ignore-user-config',
      `Run \`npx -y file:${tarball} me --json\` and print only the JSON output.`,
    ],
    spawnImpl,
    env,
  })
}

function runGeminiLane({ tarball, spawnImpl, env }) {
  return runAdvisoryLane({
    lane: 'gemini-cli-via-exec',
    envVarName: 'GEMINI_TEST_API_KEY',
    spawnArgs: [
      '--yes',
      RUNTIME_PINS.gemini,
      '-p',
      `Run \`npx -y file:${tarball} me --json\` and print only the JSON output.`,
      '--output-format',
      'json',
    ],
    spawnImpl,
    env,
  })
}

// ─────────────────────────── runLane dispatcher ───────────────────────────

/**
 * Dispatch a lane invocation. `spawnImpl` and `fsImpl` are dependency-injected
 * so unit tests can mock them; CLI defaults to real `node:child_process.spawnSync`
 * and `node:fs`.
 *
 * @param {object} params
 * @param {string} params.lane — lane name OR 'all'
 * @param {string} [params.tarball]
 * @param {string} [params.skillPath]
 * @param {Function} [params.spawnImpl]
 * @param {{readFileSync: Function}} [params.fsImpl]
 * @param {Record<string,string|undefined>} [params.env]
 */
export async function runLane({
  lane,
  tarball,
  skillPath,
  spawnImpl = realSpawnSync,
  fsImpl = { readFileSync: realReadFileSync },
  env = process.env,
}) {
  if (lane === 'all') {
    const lanes = []
    for (const laneName of Object.keys(LANES)) {
      // sequential — local --lane=all shares cwd / /tmp; CI matrix isolates per runner
      lanes.push(
        await runLane({ lane: laneName, tarball, skillPath, spawnImpl, fsImpl, env }),
      )
    }
    // Aggregate ok: every release-blocking lane must be ok:true. Advisory failures
    // do NOT poison the aggregate (they were never blocking by definition).
    const aggregateOk = lanes.every((r) => {
      const meta = LANES[r.lane]
      if (!meta) return r.ok === true
      if (meta.blocking) return r.ok === true
      return true // advisory lane: outcome doesn't gate aggregate
    })
    return { ok: aggregateOk, lane: 'all', lanes }
  }

  if (!Object.hasOwn(LANES, lane)) {
    return { ok: false, lane, reason: `unknown lane: ${lane}` }
  }

  switch (lane) {
    case 'plain-bash':
      return runPlainBashLane({ tarball, spawnImpl, env })
    case 'claude-code-via-skill':
      return runClaudeCodeViaSkillLane({ tarball, skillPath, spawnImpl, fsImpl, env })
    case 'codex-cli-via-exec':
      return runCodexLane({ tarball, spawnImpl, env })
    case 'gemini-cli-via-exec':
      return runGeminiLane({ tarball, spawnImpl, env })
    default:
      return { ok: false, lane, reason: `unhandled lane: ${lane}` }
  }
}

// ─────────────────────────── CLI entry ───────────────────────────

function usage() {
  return [
    'smoke-runtime-matrix.mjs — Cross-runtime smoke matrix for linear-agent.',
    '',
    'Usage:',
    '  node scripts/smoke-runtime-matrix.mjs --lane=<lane> [--tarball=./linear-agent-X.Y.Z.tgz] [--skill-path=./skills/linear-agent/SKILL.md]',
    '',
    'Lanes:',
    '  plain-bash             release-blocking — npx --yes file:./<tarball> me --json',
    '  claude-code-via-skill  release-blocking — extract skill invocation, assert version match',
    '  codex-cli-via-exec     advisory — needs CODEX_TEST_API_KEY env',
    '  gemini-cli-via-exec    advisory — needs GEMINI_TEST_API_KEY env',
    '  all                    run all four sequentially',
    '',
    'Exit code: 0 if no release-blocking lane failed; 1 otherwise.',
  ].join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed._help) {
    process.stdout.write(usage() + '\n')
    return 0
  }

  if (parsed._unknownFlags.length > 0) {
    process.stderr.write(`unknown flag(s): ${parsed._unknownFlags.join(', ')}\n\n`)
    process.stderr.write(usage() + '\n')
    return 1
  }

  if (!parsed.lane) {
    process.stderr.write('error: --lane=<lane> is required\n\n')
    process.stderr.write(usage() + '\n')
    return 1
  }

  // Resolve --skill-path (default relative to cwd)
  const skillPath = parsed.skillPath ?? resolve(process.cwd(), 'skills/linear-agent/SKILL.md')

  // Resolve --tarball
  let tarball = parsed.tarball
  if (!tarball) {
    tarball = findTarball(process.cwd())
    if (!tarball) {
      process.stderr.write(
        'error: --tarball=<path> not provided and no linear-agent-*.tgz found in cwd. ' +
          'Run `npm pack` first.\n',
      )
      return 1
    }
  } else {
    tarball = resolve(process.cwd(), tarball)
  }
  if (!existsSync(tarball)) {
    process.stderr.write(`error: tarball not found: ${tarball}\n`)
    return 1
  }

  // Validate lane name (early-exit instead of waiting for runLane)
  if (parsed.lane !== 'all' && !Object.hasOwn(LANES, parsed.lane)) {
    process.stderr.write(`error: unknown lane: ${parsed.lane}\n\n`)
    process.stderr.write(usage() + '\n')
    return 1
  }

  const result = await runLane({
    lane: parsed.lane,
    tarball,
    skillPath,
  })

  process.stdout.write(JSON.stringify(result) + '\n')

  // Exit code: 0 if aggregate / single-lane returned ok:true.
  // For --lane=all, runLane already excludes advisory failures from aggregate.
  return result.ok ? 0 : 1
}

// Run as CLI when invoked directly; library when imported.
// Use the same pattern as measure-cold-start.mjs / verify-pack.mjs:
// fileURLToPath(import.meta.url) gives the canonical, platform-correct
// filesystem path (handles `file:///C:/...` on Windows and POSIX symlink
// realpaths). The naive `file://${process.argv[1]}` pattern produces
// malformed file URLs on Windows and the script silently no-ops.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`fatal: ${err?.stack ?? err}\n`)
      process.exit(1)
    })
}
