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
import { readFileSync as realReadFileSync, readdirSync, existsSync, statSync } from 'node:fs'
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
 * Auto-discover the most-recently-modified `linear-agent-*.tgz` in `cwd`.
 *
 * Why mtime (not lex sort): lex sort breaks for SemVer (e.g.,
 * `linear-agent-0.1.10.tgz` sorts before `linear-agent-0.1.2.tgz`) and
 * disagrees with `measure-cold-start.mjs:findTarball` when multiple
 * tarballs coexist locally (e.g., `0.1.0-rc.1.tgz` and `0.1.0.tgz`).
 * Cold-start times the just-packed tarball; this script must agree, or
 * a maintainer running both back-to-back gets inconsistent measurements.
 *
 * Returns the absolute path, or null on no match. Files not matching
 * `^linear-agent-.*\.tgz$` are filtered out.
 *
 * @param {string} cwd
 */
export function findTarball(cwd) {
  let entries
  try {
    entries = readdirSync(cwd)
  } catch {
    return null
  }
  const matches = entries.filter((f) => /^linear-agent-.*\.tgz$/.test(f))
  if (matches.length === 0) return null
  let best = null
  let bestMtime = -Infinity
  for (const f of matches) {
    const path = resolve(cwd, f)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.mtimeMs > bestMtime) {
      best = path
      bestMtime = st.mtimeMs
    }
  }
  return best
}

// ─────────────────────────── Lane implementations ───────────────────────────

/**
 * `plain-bash` lane. Spawns `npx --yes file:./<tarball> me --json` and asserts
 * the envelope. Either success-with-key OR no-key-WORKSPACE_NOT_RESOLVED is
 * acceptable — both prove the CLI is reachable and the envelope contract holds.
 */
function runPlainBashLane({ tarball, spawnImpl, env }) {
  // Build the child env up front so we can pass the SAME object to both
  // spawn and redact. The child sees LINEAR_API_KEY=LINEAR_TEST_API_KEY
  // even if the parent's LINEAR_API_KEY is unset; redacting only against
  // the parent env would miss the child's value if a future change made
  // them different (transformation, wrapper, separate workspace token).
  // Sourcing both from the SAME object keeps the redact contract symmetric
  // with what the child actually saw.
  const childEnv = { ...env, LINEAR_API_KEY: env.LINEAR_TEST_API_KEY ?? '' }
  const result = spawnImpl('npx', ['--yes', `file:${tarball}`, 'me', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: childEnv,
    timeout: 60_000,
  })
  if (result.status === null) {
    return {
      ok: false,
      lane: 'plain-bash',
      reason: redact(`spawn signal: ${result.signal}`, childEnv),
    }
  }
  // The CLI may emit two JSON objects on non-zero exit: our envelope first,
  // then oclif's `{ "error": { "code": "EEXIT", ... } }` wrapper. Take the
  // first parseable JSON object whose shape matches our envelope ($apiVersion
  // is the discriminator).
  let parsed = parseEnvelopeFromStdout(String(result.stdout ?? ''))
  if (!parsed) {
    const sample = redact(String(result.stdout ?? '').slice(0, 200), childEnv)
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
      reason: `bad $apiVersion: ${redact(String(parsed.$apiVersion), childEnv)}`,
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
 *
 * Phase 7 PLAN 07-08 — G-03 SKILL doc-truth gate (D-04). After the
 * version-match + plain-bash baseline, the lane runs FOUR additional
 * assertions that exercise the four documented SKILL.md.tmpl examples
 * end-to-end against the packaged tarball. Without these, the entire G-02
 * class of bugs (broken `--variables` flag, broken `--no-meta` parsing,
 * broken `--retry`, unsupported `describe errors`) would sail past CI as
 * it did in the v1.0 audit. Future doc-vs-code drift now fails this lane.
 *
 * Each assertion is small and targeted (flag-recognition / envelope shape /
 * doc text) — NO Linear API calls, NO real network. Failure modes are:
 *   1. `unknown flag --vars`        → SKILL example at line 117 broken
 *   2. `--no-meta` did NOT drop meta → SKILL example at line 152 broken
 *   3. `unknown flag --retry`       → SKILL example at line 164 broken
 *   4. `describe errors` still in SKILL → 07-07 fix regressed
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
  // Baseline: re-use plain-bash's envelope assertions for `me --json`. If the
  // baseline fails, the four SKILL-example assertions below are moot — bail
  // early so the failure reason points at the actual root cause.
  const baseline = runPlainBashLane({ tarball, spawnImpl, env })
  if (!baseline.ok) {
    return { ...baseline, lane: 'claude-code-via-skill' }
  }

  // ─── SKILL doc-truth gate (Phase 7 PLAN 07-08, D-04) ────────────────
  // Build child env once; same shape as runPlainBashLane so redaction stays
  // symmetric with what the child saw.
  const childEnv = { ...env, LINEAR_API_KEY: env.LINEAR_TEST_API_KEY ?? '' }

  // ─── Assertion 1: --vars (not --variables) ─────────────────────────
  // Documented at SKILL.md.tmpl line 117 (the `raw IssueBatchCreate --vars
  // '{...}'` example). Audit G-02 found this used to say `--variables`,
  // which oclif rejects. We assert the flag is RECOGNIZED — the underlying
  // call may still fail downstream (auth / validation), but a failure-
  // envelope with WORKSPACE_NOT_RESOLVED proves the parser saw `--vars`.
  // Detection: if stdout/stderr complains "unknown flag --vars", fail.
  {
    const r = spawnImpl(
      'npx',
      [
        '--yes',
        `file:${tarball}`,
        'raw',
        'IssueQuery',
        '--vars',
        '{"id":"abc"}',
        '--json',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: childEnv,
        timeout: 60_000,
      },
    )
    const combined = redact(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, childEnv)
    if (
      /(?:unknown|nonexistent|unrecognized).*--?vars\b/i.test(combined) ||
      /--?vars.*(?:unknown|nonexistent|unrecognized)/i.test(combined)
    ) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: '--vars flag unrecognized (SKILL example at line 117 regressed)',
      }
    }
    // WR-01: doc-text half of the contract. The runtime check above proves the
    // CLI accepts `--vars`; this proves SKILL.md.tmpl still TELLS agents to
    // pass `--vars` (vs the audit-G-02 bad `--variables` form). A future
    // doc-only regression that flips line 117 back to `--variables` while the
    // runtime keeps working would still pass the runtime check; this catches
    // it.
    if (!/raw\s+\S+\s+--vars\b/i.test(String(skillBody))) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: 'SKILL no longer documents --vars on raw (G-02 audit regressed)',
      }
    }
  }

  // ─── Assertion 2: --no-meta drops meta on success envelopes ────────
  // Documented at SKILL.md.tmpl line 152. Per Phase 6 D-MNT-02, `--no-meta`
  // drops the meta block from SUCCESS envelopes only — failure envelopes
  // are unchanged for debuggability. So:
  //   - if env.ok === true:  meta MUST NOT be present
  //   - if env.ok === false: meta is allowed (failure path is exempt)
  // In CI this typically lands on the failure path (no test token), which
  // means the assertion exercises the parse path — without DEF-07-01's
  // `aliases: ['no-meta']` fix on BASE_FLAGS.noMeta, oclif rejects the
  // flag at parse time and the spawn returns a parse error rather than an
  // envelope, which would also fail this assertion (no envelope parsed).
  {
    const r = spawnImpl(
      'npx',
      ['--yes', `file:${tarball}`, 'issue', 'list', '--json', '--no-meta'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: childEnv,
        timeout: 60_000,
      },
    )
    const combined = redact(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, childEnv)
    if (/(?:unknown|nonexistent|unrecognized).*--?no-?meta\b/i.test(combined)) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: '--no-meta flag unrecognized (DEF-07-01 regression — see workspace-runtime BASE_FLAGS aliases)',
      }
    }
    const parsed = parseEnvelopeFromStdout(String(r.stdout ?? ''))
    // A success envelope MUST NOT carry `meta` under --no-meta. A failure
    // envelope MAY carry `meta` (Phase 6 D-MNT-02 makes failure exempt).
    if (parsed && parsed.ok === true && Object.hasOwn(parsed, 'meta')) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: '--no-meta did NOT drop meta on success envelope (SKILL example at line 152 regressed)',
      }
    }
  }

  // ─── Assertion 2b (WR-02): offline meta-drop semantics via `describe me` ──
  // The `issue list --no-meta` check above only exercises the meta-drop
  // SEMANTICS when the envelope is ok:true — and in default CI without
  // LINEAR_TEST_API_KEY that envelope is `ok:false WORKSPACE_NOT_RESOLVED`,
  // which is exempt from meta-drop per Phase 6 D-MNT-02. So the production
  // smoke effectively only tested the parse path in CI.
  //
  // `describe me` is a curated no-network introspection command (Phase 4
  // PLAN 04-03, INT-02): it reads from the in-process registry only and
  // returns ok:true deterministically with NO API key required. Adding this
  // sub-step gives us a real meta-drop semantic check that runs on every
  // CI invocation regardless of token availability.
  {
    const r = spawnImpl(
      'npx',
      ['--yes', `file:${tarball}`, 'describe', 'me', '--json', '--no-meta'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: childEnv,
        timeout: 60_000,
      },
    )
    const parsed = parseEnvelopeFromStdout(String(r.stdout ?? ''))
    if (!parsed || parsed.$apiVersion !== '1') {
      const sample = redact(String(r.stdout ?? '').slice(0, 200), childEnv)
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: `describe me --no-meta returned no envelope (status=${r.status}): ${sample}`,
      }
    }
    // describe is no-network and `me` is in the curated registry, so this
    // MUST be ok:true. Anything else means describe-runtime regressed.
    if (parsed.ok !== true) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: `describe me --no-meta returned ok:false (code=${parsed.error?.code ?? 'none'})`,
      }
    }
    // The meta-drop contract for success envelopes: --no-meta MUST strip
    // the meta key. This now runs in default CI without any token.
    if (Object.hasOwn(parsed, 'meta')) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: '--no-meta did NOT drop meta on `describe me` success envelope (D-MNT-02 regressed)',
      }
    }
  }

  // ─── Assertion 3: --retry N propagates ─────────────────────────────
  // Documented at SKILL.md.tmpl line 164. We're not exercising the retry
  // mechanism end-to-end (that's covered by transport-layer tests); we're
  // asserting the doc's `--retry 2` invocation is RECOGNIZED at the parse
  // layer. If 07-07's BASE_FLAGS retry threading regresses on `issue list`,
  // this fails with "unknown flag --retry".
  {
    const r = spawnImpl(
      'npx',
      ['--yes', `file:${tarball}`, 'issue', 'list', '--json', '--retry', '2'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: childEnv,
        timeout: 60_000,
      },
    )
    const combined = redact(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, childEnv)
    if (/(?:unknown|nonexistent|unrecognized).*--?retry\b/i.test(combined)) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: '--retry flag unrecognized (SKILL example at line 164 regressed)',
      }
    }
    // WR-01: doc-text half of the contract. Mirrors the --vars assertion: a
    // doc-only regression that drops the `--retry` example from SKILL.md.tmpl
    // (line 164) while leaving runtime acceptance intact would otherwise sail
    // past CI. 07-07 added this example explicitly; this guard prevents its
    // silent removal.
    if (!/--retry\b/i.test(String(skillBody))) {
      return {
        ok: false,
        lane: 'claude-code-via-skill',
        reason: 'SKILL no longer documents --retry (07-07 fix regressed)',
      }
    }
  }

  // ─── Assertion 4: SKILL no longer references `describe errors` ─────
  // 07-07 removed the `describe errors --json` example because the curated
  // registry has no `errors` entry — the example would error with
  // UNKNOWN_OPERATION. This assertion guards against the doc resurrecting
  // the broken phrasing in a future edit.
  if (/describe\s+errors/i.test(String(skillBody))) {
    return {
      ok: false,
      lane: 'claude-code-via-skill',
      reason: 'SKILL still references unsupported `describe errors` command (07-07 fix regressed)',
    }
  }

  return { ok: true, lane: 'claude-code-via-skill', output: baseline.output }
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
  // Build the child env up front so the redact value-set covers the
  // child's LINEAR_API_KEY (= LINEAR_TEST_API_KEY) even when the parent's
  // own LINEAR_API_KEY is unset. See runPlainBashLane for the rationale.
  const childEnv = { ...env, LINEAR_API_KEY: env.LINEAR_TEST_API_KEY ?? '' }
  const result = spawnImpl('npx', spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: childEnv,
    timeout: 120_000,
  })
  // Capture limited slices of stdout/stderr, redacted against the child env
  // (so child-only values like LINEAR_API_KEY get scrubbed even if the
  // parent didn't have them set).
  const stdoutSlice = redact(String(result.stdout ?? '').slice(0, 5000), childEnv)
  const stderrSlice = redact(String(result.stderr ?? '').slice(0, 2000), childEnv)
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
