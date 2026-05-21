import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// js-yaml is a transitive dep of @graphql-codegen/cli; safe to import here.
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/schema-diff.yml')

interface Step {
  name?: string
  uses?: string
  with?: Record<string, unknown>
  run?: string
  if?: string
  id?: string
  env?: Record<string, string>
}

interface Job {
  name?: string
  'runs-on'?: string
  'timeout-minutes'?: number
  steps?: Step[]
}

interface Workflow {
  name?: string
  on?: unknown
  permissions?: Record<string, string>
  jobs?: Record<string, Job>
}

function loadWorkflow(): Workflow {
  return yaml.load(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow
}

/** YAML parses unquoted top-level `on:` to JS boolean `true`. Be tolerant of either key. */
function getTriggers(wf: Workflow): Record<string, unknown> {
  const trig =
    (wf as unknown as Record<string, unknown>).on ?? (wf as unknown as Record<string, unknown>).true
  return (trig ?? {}) as Record<string, unknown>
}

function getDiffJob(wf: Workflow): Job {
  const job = wf.jobs?.diff
  if (!job) throw new Error('expected jobs.diff to be defined')
  return job
}

function getSteps(job: Job): Step[] {
  return job.steps ?? []
}

describe('.github/workflows/schema-diff.yml structural contract', () => {
  it('file exists', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true)
  })

  it('parses as YAML', () => {
    const text = readFileSync(WORKFLOW_PATH, 'utf8')
    expect(() => yaml.load(text)).not.toThrow()
  })

  it('has weekly Monday 12:00 UTC cron + workflow_dispatch trigger', () => {
    const wf = loadWorkflow()
    const triggers = getTriggers(wf)
    const schedule = triggers.schedule as Array<{ cron?: string }> | undefined
    expect(schedule).toBeDefined()
    expect(schedule).toEqual([{ cron: '0 12 * * 1' }])
    // workflow_dispatch may parse as `null` (YAML "key: <empty>") or `{}`; both are truthy keys.
    expect(Object.keys(triggers)).toContain('workflow_dispatch')
  })

  it('declares contents:write and pull-requests:write permissions', () => {
    const wf = loadWorkflow()
    expect(wf.permissions).toBeDefined()
    expect(wf.permissions?.contents).toBe('write')
    expect(wf.permissions?.['pull-requests']).toBe('write')
  })

  it('pins action versions (no @main / @master)', () => {
    const job = getDiffJob(loadWorkflow())
    const uses = getSteps(job)
      .map((s) => s.uses)
      .filter((u): u is string => Boolean(u))
    // Actions/checkout and actions/setup-node are allowed to advance majors
    // via Dependabot; we only assert they are pinned to a specific major (not
    // floating @main/@master/@latest). peter-evans/create-pull-request stays
    // pinned to v8 per RESEARCH §3 (v6 has a known regression we must avoid).
    expect(uses.some((u) => /^actions\/checkout@v\d+$/.test(u))).toBe(true)
    expect(uses.some((u) => /^actions\/setup-node@v\d+$/.test(u))).toBe(true)
    expect(uses).toContain('peter-evans/create-pull-request@v8')
    // Anti-regression: never v6 (RESEARCH §3 correction).
    const prAction = uses.find((u) => u.startsWith('peter-evans/create-pull-request@'))
    expect(prAction).toBe('peter-evans/create-pull-request@v8')
    for (const u of uses) {
      expect(u).not.toMatch(/@main$|@master$/)
    }
  })

  it('pins @graphql-inspector/cli@6.0.8 in diff and introspect invocations', () => {
    const job = getDiffJob(loadWorkflow())
    const allRuns = getSteps(job)
      .map((s) => s.run)
      .filter((r): r is string => Boolean(r))
      .join('\n')
    expect(allRuns).toContain('@graphql-inspector/cli@6.0.8')
    // No floating @latest pin.
    expect(allRuns).not.toContain('@graphql-inspector/cli@latest')
  })

  it('uses Authorization: header form WITHOUT Bearer prefix (Linear convention)', () => {
    const job = getDiffJob(loadWorkflow())
    const allRuns = getSteps(job)
      .map((s) => s.run)
      .filter((r): r is string => Boolean(r))
      .join('\n')
    expect(allRuns).toContain('Authorization: ${LINEAR_API_KEY}')
    expect(allRuns).not.toMatch(/Authorization:\s*Bearer/)
    expect(allRuns).not.toContain('--token ')
  })

  it('uses LINEAR_TEST_API_KEY secret at the env level', () => {
    const job = getDiffJob(loadWorkflow())
    const envs = getSteps(job)
      .map((s) => s.env)
      .filter((e): e is Record<string, string> => Boolean(e))
    const hasLinearKey = envs.some((e) => e.LINEAR_API_KEY === '${{ secrets.LINEAR_TEST_API_KEY }}')
    expect(hasLinearKey).toBe(true)
  })

  it('refreshes codegen/linear-schema-source.graphql BEFORE npm run fetch-schema', () => {
    const job = getDiffJob(loadWorkflow())
    const refreshStep = getSteps(job).find(
      (s) => typeof s.run === 'string' && s.run.includes('codegen/linear-schema-source.graphql'),
    )
    expect(refreshStep).toBeDefined()
    expect(refreshStep?.run).toMatch(
      /introspect[\s\S]*--write[\s\S]*linear-schema-source\.graphql[\s\S]*npm run fetch-schema/,
    )
  })

  it('uses stable branch schema-sync/auto for idempotent PR updates (NOT date-stamped)', () => {
    const job = getDiffJob(loadWorkflow())
    const prStep = getSteps(job).find((s) => s.uses?.startsWith('peter-evans/create-pull-request'))
    expect(prStep).toBeDefined()
    expect(prStep?.with).toBeDefined()
    expect(prStep?.with?.branch).toBe('schema-sync/auto')
    // Anti-regression: never date-stamped (RESEARCH §3 correction).
    expect(String(prStep?.with?.branch)).not.toMatch(/\$\{\{|date|<date>/i)
  })

  it("PR step gates on has_diff == 'true' and base is main", () => {
    const job = getDiffJob(loadWorkflow())
    const prStep = getSteps(job).find((s) => s.uses?.startsWith('peter-evans/create-pull-request'))
    expect(prStep).toBeDefined()
    expect(prStep?.if).toContain("has_diff == 'true'")
    expect(prStep?.with?.base).toBe('main')
  })

  it('breaking-change path writes to GITHUB_STEP_SUMMARY and exits 1', () => {
    const job = getDiffJob(loadWorkflow())
    const diffStep = getSteps(job).find((s) => s.id === 'diff')
    expect(diffStep).toBeDefined()
    expect(diffStep?.run).toContain('$GITHUB_STEP_SUMMARY')
    expect(diffStep?.run).toMatch(/exit 1/)
  })

  it('captures exit code under set +e / set -e brackets', () => {
    const job = getDiffJob(loadWorkflow())
    const diffStep = getSteps(job).find((s) => s.id === 'diff')
    expect(diffStep?.run).toContain('set +e')
    expect(diffStep?.run).toContain('set -e')
  })

  it('runs on ubuntu-latest with bounded timeout', () => {
    const job = getDiffJob(loadWorkflow())
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15)
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(5)
  })

  it('node setup uses Node 22 LTS with npm cache', () => {
    const job = getDiffJob(loadWorkflow())
    const nodeStep = getSteps(job).find((s) => s.uses?.startsWith('actions/setup-node@'))
    expect(nodeStep).toBeDefined()
    expect(nodeStep?.uses).toMatch(/^actions\/setup-node@v\d+$/)
    expect(String(nodeStep?.with?.['node-version'])).toBe('22')
    expect(nodeStep?.with?.cache).toBe('npm')
  })
})
