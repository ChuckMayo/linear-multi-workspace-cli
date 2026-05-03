#!/usr/bin/env node
/**
 * smoke-phase-2.mjs — End-to-end smoke for Phase 2 curated commands.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... node scripts/smoke-phase-2.mjs --team ENG [--keep] [--burst]
 *   # OR rely on an active workspace from config:
 *   node scripts/smoke-phase-2.mjs --team ENG
 *
 * Flags:
 *   --team <key|uuid>   Target team for create/transition/cycle operations (required)
 *   --keep              Skip the final purge step (test issue stays in trash for inspection)
 *   --burst             Loop a cheap query until Linear returns RATELIMITED, then assert
 *                       the transport wrapper retried with backoff and meta.complexity is
 *                       populated. Adds ~30-60s to the run.
 *   --workspace <name>  Override the active workspace
 *
 * What it does:
 *   1. Sanity: `me`, `whoami`, `team list`, `state list --team`, `label list --team`,
 *      `cycle list --team`, `project list`
 *   2. Lifecycle: `issue create` → `issue get` → `issue update` → `issue transition` →
 *      `issue search` (finds the new issue by title) → `comment {create, list, update, delete}`
 *   3. Three-state delete: `issue archive` → `issue trash` → (optional) `issue purge --yes`
 *   4. Snippet capture: writes one `issue search` result's `metadata` to
 *      scripts/fixtures/search-snippet.json so the planner can pin the shape
 *   5. (--burst) RATELIMITED handling: loops `issue list --limit 1` until rate-limited,
 *      asserts retry behavior + meta.complexity surfacing
 *
 * Output: human-readable progress on stderr; final JSON envelope summary on stdout
 * with `{ ok: bool, steps: [...], duration_ms }`.
 *
 * Exits 0 on success, 1 on first failure (no recovery — operator inspects and fixes).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..')
const BIN = resolve(REPO_ROOT, 'bin/run.js')
const FIXTURES_DIR = resolve(REPO_ROOT, 'scripts/fixtures')

// ───────────────────────────────────────── arg parsing ─────────────────────────────────────────

const args = process.argv.slice(2)
let team = null
let workspace = null
let keep = false
let burst = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--team') team = args[++i]
  else if (args[i] === '--workspace') workspace = args[++i]
  else if (args[i] === '--keep') keep = true
  else if (args[i] === '--burst') burst = true
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(readDocstring())
    process.exit(0)
  } else {
    console.error(`Unknown arg: ${args[i]}`)
    process.exit(2)
  }
}

if (!team) {
  console.error('ERROR: --team <key|uuid> is required')
  process.exit(2)
}

// ───────────────────────────────────────── helpers ─────────────────────────────────────────

const startTs = Date.now()
const steps = []
let testIssueId = null
let testIssueIdentifier = null

function readDocstring() {
  // Strip the JSDoc header lines from this file's source
  return [
    'smoke-phase-2.mjs — End-to-end smoke for Phase 2 curated commands.',
    '',
    'Usage:',
    '  LINEAR_API_KEY=lin_api_... node scripts/smoke-phase-2.mjs --team ENG [--keep] [--burst]',
    '',
    'See script header for details.',
  ].join('\n')
}

function log(msg) {
  process.stderr.write(`[smoke] ${msg}\n`)
}

function run(label, cliArgs, { allowFailure = false } = {}) {
  log(`▶ ${label}`)
  const args = [BIN, ...cliArgs]
  if (workspace) args.push('--workspace', workspace)
  const res = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  let parsed = null
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    /* not JSON — captured below */
  }
  const ok = res.status === 0 && parsed && parsed.ok === true
  const step = {
    label,
    cliArgs,
    exitCode: res.status,
    ok,
    error: parsed && !parsed.ok ? parsed.error : null,
    stderr_tail: res.stderr ? res.stderr.split('\n').slice(-3).join('\n') : null,
  }
  steps.push(step)
  if (!ok && !allowFailure) {
    process.stdout.write(JSON.stringify({ ok: false, failed_at: label, step, steps, duration_ms: Date.now() - startTs }, null, 2) + '\n')
    process.exit(1)
  }
  return { ok, parsed, raw: res.stdout, stderr: res.stderr }
}

function getData(result, path) {
  // path is a string like 'data.issue.id'
  let cur = result.parsed
  for (const key of path.split('.')) {
    if (cur == null) return null
    cur = cur[key]
  }
  return cur
}

// ───────────────────────────────────────── 1. Sanity reads ─────────────────────────────────────────

run('me', ['me'])
run('whoami', ['whoami'])
run('team list', ['team', 'list', '--limit', '5'])
run('team get', ['team', 'get', team])
run('state list --team', ['state', 'list', '--team', team, '--limit', '20'])
run('label list', ['label', 'list', '--team', team, '--limit', '10'])
run('cycle list --team', ['cycle', 'list', '--team', team, '--limit', '5'])
run('project list', ['project', 'list', '--limit', '5'])

// ───────────────────────────────────────── 2. Issue lifecycle ─────────────────────────────────────────

const testTitle = `smoke-phase-2 ${new Date().toISOString()}`
const created = run('issue create', [
  'issue', 'create',
  '--title', testTitle,
  '--team', team,
  '--description', 'created by scripts/smoke-phase-2.mjs — safe to delete',
])
testIssueId = getData(created, 'data.id')
testIssueIdentifier = getData(created, 'data.identifier')
if (!testIssueId || !testIssueIdentifier) {
  log(`ERROR: issue create succeeded but missing id/identifier in data: ${JSON.stringify(created.parsed?.data).slice(0, 200)}`)
  process.exit(1)
}
log(`  created ${testIssueIdentifier} (${testIssueId})`)

run('issue get (by identifier)', ['issue', 'get', testIssueIdentifier])
run('issue get (by uuid)', ['issue', 'get', testIssueId])

run('issue update --description', [
  'issue', 'update', testIssueIdentifier,
  '--description', 'updated by smoke',
])

// Pick any non-default state from `state list` output
const statesRes = run('state list (for transition target)', ['state', 'list', '--team', team, '--limit', '20'])
const states = getData(statesRes, 'data') || []
const targetState = states.find((s) => s && /in.progress|todo|backlog/i.test(s.name)) || states[1]
if (targetState && targetState.name) {
  run('issue transition', ['issue', 'transition', testIssueIdentifier, targetState.name])
} else {
  log('  WARN: no eligible state found for transition; skipping')
}

const searchRes = run('issue search', [
  'issue', 'search', testTitle.slice(0, 30),
  '--limit', '5',
])
// Capture snippet shape for the planner if any result has metadata
const searchData = getData(searchRes, 'data') || []
if (searchData.length > 0 && searchData[0].metadata) {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true })
  const fixturePath = resolve(FIXTURES_DIR, 'search-snippet.json')
  writeFileSync(fixturePath, JSON.stringify(searchData[0].metadata, null, 2))
  log(`  snippet shape captured → scripts/fixtures/search-snippet.json`)
}

// ───────────────────────────────────────── 3. Comments ─────────────────────────────────────────

const commented = run('comment create', [
  'comment', 'create',
  '--issue', testIssueIdentifier,
  '--body', 'smoke comment 1',
])
const commentId = getData(commented, 'data.id')

run('comment list --issue', ['comment', 'list', '--issue', testIssueIdentifier])

if (commentId) {
  run('comment update', ['comment', 'update', '--id', commentId, '--body', 'smoke comment 1 (updated)'])
  run('comment delete', ['comment', 'delete', '--id', commentId])
}

// ───────────────────────────────────────── 4. Three-state delete ─────────────────────────────────────────

run('issue archive', ['issue', 'archive', testIssueIdentifier])
run('issue trash', ['issue', 'trash', testIssueIdentifier])

if (!keep) {
  run('issue purge --yes', ['issue', 'purge', testIssueIdentifier, '--yes'])
}

// ───────────────────────────────────────── 5. Burst mode (rate-limit) ─────────────────────────────────────────

if (burst) {
  log('--burst enabled: looping `issue list --limit 1` until RATELIMITED…')
  let burstStartedAt = Date.now()
  let attempts = 0
  let maxComplexity = 0
  let sawComplexity = false
  let sawRateLimit = false
  while (Date.now() - burstStartedAt < 60_000) {
    attempts++
    const r = spawnSync('node', [BIN, 'issue', 'list', '--limit', '1'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
    })
    let parsed = null
    try { parsed = JSON.parse(r.stdout) } catch {}
    if (parsed?.meta?.complexity) {
      sawComplexity = true
      maxComplexity = Math.max(maxComplexity, parsed.meta.complexity.cost ?? 0)
    }
    if (parsed?.error?.code === 'RATELIMITED' || parsed?.error?.code === 'RATE_LIMIT_EXCEEDED') {
      sawRateLimit = true
      log(`  RATELIMITED at attempt ${attempts} after ${Math.round((Date.now() - burstStartedAt) / 1000)}s; transient=${parsed.error.transient}`)
      break
    }
  }
  steps.push({
    label: 'burst',
    attempts,
    saw_complexity_meta: sawComplexity,
    saw_rate_limit: sawRateLimit,
    max_complexity_cost: maxComplexity,
  })
  if (!sawComplexity) {
    log('  WARN: --burst completed without observing meta.complexity — header capture may be broken')
  }
  if (!sawRateLimit) {
    log(`  NOTE: --burst did not trigger RATELIMITED in 60s (Linear may not rate-limit cheap queries quickly)`)
  }
}

// ───────────────────────────────────────── exit ─────────────────────────────────────────

const summary = {
  ok: true,
  team,
  test_issue_identifier: testIssueIdentifier,
  test_issue_id: testIssueId,
  kept: keep,
  burst,
  steps_count: steps.length,
  steps,
  duration_ms: Date.now() - startTs,
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
log(`✓ smoke complete in ${Math.round(summary.duration_ms / 1000)}s`)
