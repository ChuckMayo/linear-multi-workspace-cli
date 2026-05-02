import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// js-yaml is a transitive dep of @graphql-codegen/cli; safe to import here.
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CI = resolve(ROOT, '.github/workflows/ci.yml')
const DEPENDABOT = resolve(ROOT, '.github/dependabot.yml')

interface CiWorkflow {
  name?: string
  on?: unknown
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs?: Record<
    string,
    {
      'runs-on'?: string
      'timeout-minutes'?: number
      permissions?: Record<string, string>
      steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>
    }
  >
}

interface DependabotConfig {
  version?: number
  updates?: Array<{
    'package-ecosystem'?: string
    directory?: string
    schedule?: { interval?: string }
  }>
}

describe('.github/workflows/ci.yml is a valid GitHub Actions workflow', () => {
  it('file exists', () => {
    expect(existsSync(CI)).toBe(true)
  })

  it('parses as YAML', () => {
    const text = readFileSync(CI, 'utf8')
    expect(() => yaml.load(text)).not.toThrow()
  })

  it('runs on push and pull_request', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    // YAML parses the unquoted key `on:` to JS boolean `true`. Be tolerant of either key.
    const triggers =
      (wf as unknown as Record<string, unknown>).on ??
      (wf as unknown as Record<string, unknown>).true
    expect(triggers).toBeDefined()
    const triggerKeys = Object.keys(triggers as Record<string, unknown>)
    expect(triggerKeys).toContain('push')
    expect(triggerKeys).toContain('pull_request')
  })

  it('uses Node 22 via actions/setup-node@v4 with npm cache', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    const job = Object.values(wf.jobs ?? {})[0]
    expect(job).toBeDefined()
    const setupNode = job?.steps?.find((s) => s.uses?.startsWith('actions/setup-node@'))
    expect(setupNode?.uses).toBe('actions/setup-node@v4')
    expect(String(setupNode?.with?.['node-version'])).toBe('22')
    expect(setupNode?.with?.cache).toBe('npm')
  })

  it('uses actions/checkout@v4', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    const job = Object.values(wf.jobs ?? {})[0]
    const checkout = job?.steps?.find((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkout?.uses).toBe('actions/checkout@v4')
  })

  it('runs npm ci, lint, typecheck, test, build (in that order)', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    const job = Object.values(wf.jobs ?? {})[0]
    const runCommands = (job?.steps ?? [])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === 'string')
    const expectedSequence = [
      'npm ci',
      'npm run lint',
      'npm run typecheck',
      'npm run test',
      'npm run build',
    ]
    let lastIdx = -1
    for (const cmd of expectedSequence) {
      const idx = runCommands.findIndex((r, i) => i > lastIdx && r.includes(cmd))
      expect(idx, `missing or out-of-order: ${cmd}`).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('has read-only permissions and a 10-minute timeout', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    const job = Object.values(wf.jobs ?? {})[0]
    expect(job?.permissions?.contents).toBe('read')
    expect(job?.['timeout-minutes']).toBe(10)
  })

  it('has concurrency cancel-in-progress', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    expect(wf.concurrency?.['cancel-in-progress']).toBe(true)
    expect(wf.concurrency?.group).toBeTruthy()
  })

  it('every npm script referenced in the workflow exists in package.json', () => {
    const wf = yaml.load(readFileSync(CI, 'utf8')) as CiWorkflow
    const job = Object.values(wf.jobs ?? {})[0]
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    const npmRunRe = /npm run (\S+)/g
    const runs = (job?.steps ?? []).flatMap((s) => {
      if (typeof s.run !== 'string') return []
      const matches: string[] = []
      let match: RegExpExecArray | null = npmRunRe.exec(s.run)
      while (match !== null) {
        if (match[1] !== undefined) matches.push(match[1])
        match = npmRunRe.exec(s.run)
      }
      return matches
    })
    expect(runs.length).toBeGreaterThan(0)
    for (const scriptName of runs) {
      expect(scripts[scriptName], `package.json missing script: ${scriptName}`).toBeTruthy()
    }
  })
})

describe('.github/dependabot.yml is configured for npm + github-actions', () => {
  it('file exists and parses as YAML version 2', () => {
    expect(existsSync(DEPENDABOT)).toBe(true)
    const cfg = yaml.load(readFileSync(DEPENDABOT, 'utf8')) as DependabotConfig
    expect(cfg.version).toBe(2)
  })

  it('has weekly npm + monthly github-actions update schedules', () => {
    const cfg = yaml.load(readFileSync(DEPENDABOT, 'utf8')) as DependabotConfig
    const updates = cfg.updates ?? []
    const npm = updates.find((u) => u['package-ecosystem'] === 'npm')
    const gha = updates.find((u) => u['package-ecosystem'] === 'github-actions')
    expect(npm).toBeDefined()
    expect(npm?.schedule?.interval).toBe('weekly')
    expect(gha).toBeDefined()
    expect(gha?.schedule?.interval).toBe('monthly')
  })
})
