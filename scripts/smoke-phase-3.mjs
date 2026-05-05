#!/usr/bin/env node
/**
 * smoke-phase-3.mjs — End-to-end smoke for Phase 3 raw GraphQL layer.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... node scripts/smoke-phase-3.mjs --workspace <name> [--keep]
 *   # OR rely on an active workspace from config:
 *   node scripts/smoke-phase-3.mjs --workspace <name>
 *
 * Flags:
 *   --workspace <name>  Target workspace for mutations (REQUIRED for write ops)
 *   --keep              Skip the final IssueDelete cleanup step (issue stays for inspection)
 *   --team <key>        Team key for IssueCreate (defaults to TEAM env var or first team)
 *
 * What it does:
 *   1. raw Issues --vars '{"first":3}' — basic query op via registry
 *   2. raw IssueCreate --workspace <ws> --allow-mutations --vars '<json>' — create test issue (capture id)
 *   3. graphql --query=@scripts/fixtures/phase-3/sample-query.graphql — free-form query
 *   4. issue get <id> --include comments — hydrate with --include (RAW-04)
 *   5. raw batch --plan=@<tmp> (dry-run) — verify plan preview; data.plan + meta.batch
 *   6. raw batch --plan=@<tmp> --workspace <ws> --allow-mutations --yes (execute) — verify data.results
 *   7. raw IssueDelete --workspace <ws> --allow-mutations --vars '{"id":"<id>"}' — cleanup
 *
 * Output: human-readable progress on stderr; final JSON summary on stdout.
 * Exits 0 on success, 1 on first failure.
 *
 * Operator-only — DO NOT run in CI. Requires a real LINEAR_API_KEY.
 */

// REVIEW WR-07: execFileSync and mkdirSync were imported but never used.
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..')
const BIN = resolve(REPO_ROOT, 'bin/run.js')
const PHASE3_FIXTURES = resolve(REPO_ROOT, 'scripts/fixtures/phase-3')

// ───────────────────────────────────────── arg parsing ─────────────────────────────────────────

const args = process.argv.slice(2)
let workspace = null
let team = null
let keep = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace') workspace = args[++i]
  else if (args[i] === '--team') team = args[++i]
  else if (args[i] === '--keep') keep = true
  else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write([
      'smoke-phase-3.mjs — End-to-end smoke for Phase 3 raw GraphQL layer.',
      '',
      'Usage:',
      '  LINEAR_API_KEY=lin_api_... node scripts/smoke-phase-3.mjs --workspace <name> [--keep]',
      '',
      'Flags:',
      '  --workspace <name>  Target workspace (REQUIRED for mutations)',
      '  --team <key>        Team key for issue create (or set TEAM env var)',
      '  --keep              Skip cleanup (issue stays for inspection)',
    ].join('\n') + '\n')
    process.exit(0)
  } else {
    process.stderr.write(`Unknown arg: ${args[i]}\n`)
    process.exit(2)
  }
}

// Fall back to env vars
if (!workspace && process.env.LINEAR_WORKSPACE) workspace = process.env.LINEAR_WORKSPACE
if (!team && process.env.TEAM) team = process.env.TEAM

if (!workspace) {
  process.stderr.write('ERROR: --workspace <name> is required (or set LINEAR_WORKSPACE in .env)\n')
  process.exit(2)
}

// ───────────────────────────────────────── helpers ─────────────────────────────────────────

const startTs = Date.now()
const steps = []
let testIssueId = null

function log(msg) {
  process.stderr.write(`[smoke-phase-3] ${msg}\n`)
}

function run(label, cliArgs, { allowFailure = false } = {}) {
  log(`▶ ${label}`)
  const fullArgs = [BIN, ...cliArgs]
  const res = spawnSync('node', fullArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  let parsed = null
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    /* not JSON */
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
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          failed_at: label,
          step,
          steps,
          duration_ms: Date.now() - startTs,
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(1)
  }
  return { ok, parsed, raw: res.stdout, stderr: res.stderr }
}

function getData(result, path) {
  let cur = result.parsed
  for (const key of path.split('.')) {
    if (cur == null) return null
    cur = cur[key]
  }
  return cur
}

function assert(cond, msg) {
  if (!cond) {
    process.stderr.write(`[smoke-phase-3] ASSERTION FAILED: ${msg}\n`)
    process.exit(1)
  }
}

// ───────────────────────────────────────── 1. raw Issues query ─────────────────────────────────────────

log('=== Scenario 1: raw Issues query ===')
const issuesResult = run('raw Issues --vars \'{"first":3}\'', [
  'raw',
  'Issues',
  '--vars',
  '{"first":3}',
])
assert(getData(issuesResult, 'data.issues') != null, 'data.issues should be present')
assert(Array.isArray(getData(issuesResult, 'data.issues.nodes')), 'data.issues.nodes should be an array')
log(`  ✓ Issues query returned ${getData(issuesResult, 'data.issues.nodes')?.length ?? 0} issues`)

// ───────────────────────────────────────── 2. raw IssueCreate ─────────────────────────────────────────

// Pick team — use --team arg, TEAM env, or first team from issue list
let teamId = team
if (!teamId) {
  // Try to infer team from issues
  const firstIssue = getData(issuesResult, 'data.issues.nodes.0')
  if (firstIssue && firstIssue.teamId) {
    teamId = firstIssue.teamId
  }
}

if (!teamId) {
  log('ERROR: --team <key> or TEAM env var is required for IssueCreate')
  process.exit(2)
}

const testTitle = `smoke-phase-3 ${new Date().toISOString()}`
log(`=== Scenario 2: raw IssueCreate (title: "${testTitle.slice(0, 50)}...") ===`)
const createVars = JSON.stringify({
  input: {
    title: testTitle,
    teamId: teamId,
    description: 'created by scripts/smoke-phase-3.mjs — safe to delete',
  },
})
const createResult = run('raw IssueCreate --allow-mutations', [
  'raw',
  'IssueCreate',
  '--workspace',
  workspace,
  '--allow-mutations',
  '--vars',
  createVars,
])

testIssueId = getData(createResult, 'data.issueCreate.issue.id')
if (!testIssueId) {
  // Some Linear schemas return it differently
  testIssueId = getData(createResult, 'data.issueCreate.id')
}
assert(testIssueId != null, 'IssueCreate should return an issue id')
log(`  ✓ Created issue ${testIssueId}`)

// ───────────────────────────────────────── 3. graphql free-form query ─────────────────────────────────────────

log('=== Scenario 3: graphql --query=@sample-query.graphql ===')
const graphqlFixture = resolve(PHASE3_FIXTURES, 'sample-query.graphql')
assert(existsSync(graphqlFixture), `sample-query.graphql fixture must exist at ${graphqlFixture}`)
const graphqlResult = run('graphql --query=@sample-query.graphql', [
  'graphql',
  `--query=@${graphqlFixture}`,
])
assert(getData(graphqlResult, 'data.viewer') != null, 'graphql query should return data.viewer')
log(`  ✓ graphql viewer: ${getData(graphqlResult, 'data.viewer.email') ?? '(email hidden)'}`)

// ───────────────────────────────────────── 4. issue get --include comments ─────────────────────────────────────────

log('=== Scenario 4: issue get --include comments ===')
const issueGetResult = run(`issue get ${testIssueId} --include comments`, [
  'issue',
  'get',
  testIssueId,
  '--include',
  'comments',
])
assert(getData(issueGetResult, 'data') != null, 'issue get should return data')
// comments may be empty but should be present if --include worked
log(`  ✓ issue get with --include comments returned data`)

// ───────────────────────────────────────── 5. raw batch dry-run ─────────────────────────────────────────

log('=== Scenario 5: raw batch --plan=@<tmp> (dry-run) ===')

// Render the batch plan: substitute __SMOKE_ISSUE_ID__ with the real issue ID
const batchPlanTemplate = JSON.parse(
  readFileSync(resolve(PHASE3_FIXTURES, 'sample-batch-plan.json'), 'utf8'),
)
const updatedTitle = `${testTitle} (batch-updated)`
const batchPlan = batchPlanTemplate.map((entry) => {
  const rendered = JSON.stringify(entry)
    .replace(/__SMOKE_ISSUE_ID__/g, testIssueId)
    .replace(/__SMOKE_UPDATED_TITLE__/g, updatedTitle)
  return JSON.parse(rendered)
})

const tmpPlanPath = resolve(tmpdir(), `smoke-phase-3-batch-${Date.now()}.json`)
writeFileSync(tmpPlanPath, JSON.stringify(batchPlan, null, 2), 'utf8')
log(`  Wrote batch plan to ${tmpPlanPath}`)

const dryRunResult = run('raw batch --plan=@<tmp> (dry-run)', [
  'raw',
  'batch',
  `--plan=@${tmpPlanPath}`,
])
assert(getData(dryRunResult, 'data.plan') != null, 'dry-run should return data.plan')
assert(
  Array.isArray(getData(dryRunResult, 'data.plan')),
  'data.plan should be an array',
)
assert(getData(dryRunResult, 'meta.batch') != null, 'dry-run should return meta.batch')
log(
  `  ✓ dry-run returned ${getData(dryRunResult, 'data.plan')?.length ?? 0} plan entries; meta.batch: ${JSON.stringify(getData(dryRunResult, 'meta.batch'))}`,
)

// ───────────────────────────────────────── 6. raw batch execute ─────────────────────────────────────────

log('=== Scenario 6: raw batch --plan=@<tmp> --workspace --allow-mutations --yes (execute) ===')
const executeResult = run('raw batch execute', [
  'raw',
  'batch',
  `--plan=@${tmpPlanPath}`,
  '--workspace',
  workspace,
  '--allow-mutations',
  '--yes',
  '--no-dry-run',
])
assert(getData(executeResult, 'data.results') != null, 'execute should return data.results')
assert(
  Array.isArray(getData(executeResult, 'data.results')),
  'data.results should be an array',
)
const results = getData(executeResult, 'data.results')
// REVIEW WR-07: previously this only logged a WARN on failed entries
// and the script continued to exit 0 — a smoke script that silently
// passes when its assertions fail is worse than no smoke script.
// Now: if any entry failed, surface the failure codes and FAIL the
// step with assert(), matching the assertion style used elsewhere.
const failures = results.filter((r) => !r.ok)
if (failures.length > 0) {
  log(
    `  FAIL: ${failures.length} batch entries failed: ${JSON.stringify(failures.map((f) => ({ op: f.operation, code: f.error?.code, message: f.error?.message })))}`,
  )
}
assert(failures.length === 0, 'all batch entries should succeed')
log(
  `  ✓ execute returned ${results.length} results; ok=${results.filter((r) => r.ok).length}/${results.length}`,
)

// Cleanup tmpfile
try {
  unlinkSync(tmpPlanPath)
} catch {
  /* ignore */
}

// ───────────────────────────────────────── 7. raw IssueDelete (cleanup) ─────────────────────────────────────────

if (!keep) {
  log('=== Scenario 7: raw IssueDelete (cleanup) ===')
  const deleteVars = JSON.stringify({ id: testIssueId })
  run('raw IssueDelete (cleanup)', [
    'raw',
    'IssueDelete',
    '--workspace',
    workspace,
    '--allow-mutations',
    '--vars',
    deleteVars,
  ])
  log(`  ✓ Deleted test issue ${testIssueId}`)
} else {
  log(`=== Scenario 7: SKIPPED (--keep) — test issue ${testIssueId} remains ===`)
}

// ───────────────────────────────────────── exit ─────────────────────────────────────────

const summary = {
  ok: true,
  workspace,
  team: teamId,
  test_issue_id: testIssueId,
  kept: keep,
  steps_count: steps.length,
  steps,
  duration_ms: Date.now() - startTs,
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
log(`✓ smoke-phase-3 complete in ${Math.round(summary.duration_ms / 1000)}s`)
