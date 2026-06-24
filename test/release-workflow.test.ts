import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// js-yaml is a transitive dep of @graphql-codegen/cli; safe to import here.
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const RELEASE = resolve(ROOT, '.github/workflows/release.yml')

interface ReleaseWorkflow {
  name?: string
  on?: unknown
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs?: Record<
    string,
    {
      'runs-on'?: string
      'timeout-minutes'?: number
      needs?: string | string[]
      permissions?: Record<string, string>
      strategy?: {
        'fail-fast'?: boolean
        matrix?: { lane?: string[] } & Record<string, unknown>
      }
      env?: Record<string, string>
      steps?: Array<{
        name?: string
        uses?: string
        run?: string
        env?: Record<string, string>
        with?: Record<string, unknown>
      }>
    }
  >
}

const EXPECTED_LANES = [
  'plain-bash',
  'claude-code-via-skill',
  'codex-cli-via-exec',
  'gemini-cli-via-exec',
] as const

function loadRelease(): ReleaseWorkflow {
  return yaml.load(readFileSync(RELEASE, 'utf8')) as ReleaseWorkflow
}

/** YAML parses unquoted top-level `on:` to JS boolean `true`. Be tolerant of either key. */
function getTriggers(wf: ReleaseWorkflow): Record<string, unknown> {
  const trig =
    (wf as unknown as Record<string, unknown>).on ?? (wf as unknown as Record<string, unknown>).true
  return (trig ?? {}) as Record<string, unknown>
}

function collectNpmRunNames(runText: string): string[] {
  const names: string[] = []
  const re = /npm run (\S+)/g
  let match = re.exec(runText)
  while (match !== null) {
    if (match[1] !== undefined) names.push(match[1])
    match = re.exec(runText)
  }
  return names
}

describe('.github/workflows/release.yml is a valid GitHub Actions workflow', () => {
  it('file exists', () => {
    expect(existsSync(RELEASE)).toBe(true)
  })

  it('parses as YAML', () => {
    const text = readFileSync(RELEASE, 'utf8')
    expect(() => yaml.load(text)).not.toThrow()
  })

  it("triggers ONLY on push tags 'v*' (no branches, no workflow_dispatch)", () => {
    const wf = loadRelease()
    const triggers = getTriggers(wf)
    expect(Object.keys(triggers)).toEqual(['push'])
    const push = triggers.push as { tags?: string[]; branches?: string[] } | undefined
    expect(push).toBeDefined()
    expect(push?.tags).toBeDefined()
    expect(push?.tags).toContain('v*')
    expect(push?.branches).toBeUndefined()
  })

  it('does NOT include workflow_dispatch trigger (firing surface minimization)', () => {
    const text = readFileSync(RELEASE, 'utf8')
    expect(text.includes('workflow_dispatch')).toBe(false)
  })

  it('concurrency.cancel-in-progress is false (do not kill in-flight publishes)', () => {
    const wf = loadRelease()
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false)
    expect(wf.concurrency?.group).toBeTruthy()
  })

  it('documents that publishing uses OIDC trusted publishing (no token)', () => {
    const text = readFileSync(RELEASE, 'utf8')
    const hasOidcComment =
      text.toLowerCase().includes('trusted publishing') || text.includes('OIDC')
    expect(
      hasOidcComment,
      'release.yml must document the OIDC trusted-publishing approach',
    ).toBe(true)
  })
})

describe('release.yml has the four jobs in the documented needs: chain', () => {
  it('defines exactly: ci, cold-start, smoke-matrix, publish', () => {
    const wf = loadRelease()
    const jobs = wf.jobs ?? {}
    const names = Object.keys(jobs).sort()
    expect(names).toEqual(['ci', 'cold-start', 'publish', 'smoke-matrix'])
  })

  it('cold-start.needs === "ci"', () => {
    const wf = loadRelease()
    expect(wf.jobs?.['cold-start']?.needs).toBe('ci')
  })

  it('smoke-matrix.needs === "ci"', () => {
    const wf = loadRelease()
    expect(wf.jobs?.['smoke-matrix']?.needs).toBe('ci')
  })

  it('publish.needs deep-equals ["ci", "cold-start", "smoke-matrix"]', () => {
    const wf = loadRelease()
    const needs = wf.jobs?.publish?.needs
    expect(Array.isArray(needs)).toBe(true)
    expect([...(needs as string[])].sort()).toEqual(['ci', 'cold-start', 'smoke-matrix'])
  })
})

describe('release.yml jobs: every job uses the same Node 22 + pinned-major checkout setup', () => {
  it('every job uses actions/checkout pinned to a specific major', () => {
    const wf = loadRelease()
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      const checkout = job?.steps?.find((s) => s.uses?.startsWith('actions/checkout@'))
      expect(checkout?.uses, `job ${name}: actions/checkout pin missing`).toMatch(
        /^actions\/checkout@v\d+$/,
      )
    }
  })

  it("every job uses actions/setup-node (pinned major) with node-version '22' and cache 'npm'", () => {
    const wf = loadRelease()
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      const setupNode = job?.steps?.find((s) => s.uses?.startsWith('actions/setup-node@'))
      expect(setupNode?.uses, `job ${name}: actions/setup-node pin missing`).toMatch(
        /^actions\/setup-node@v\d+$/,
      )
      expect(String(setupNode?.with?.['node-version']), `job ${name}: node-version`).toBe('22')
      expect(setupNode?.with?.cache, `job ${name}: cache`).toBe('npm')
    }
  })
})

describe('release.yml ci job runs the dev-loop gates + verify-pack', () => {
  it('runs lint, typecheck, test, build, verify-pack (in that order)', () => {
    const wf = loadRelease()
    const job = wf.jobs?.ci
    const runs = (job?.steps ?? [])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === 'string')
    const expectedSequence = [
      'npm ci',
      'npm run lint',
      'npm run typecheck',
      'npm run test',
      'npm run build',
      'verify-pack.mjs',
    ]
    let lastIdx = -1
    for (const cmd of expectedSequence) {
      const idx = runs.findIndex((r, i) => i > lastIdx && r.includes(cmd))
      expect(idx, `ci job: missing or out-of-order: ${cmd}`).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('ci job has read-only permissions', () => {
    const wf = loadRelease()
    expect(wf.jobs?.ci?.permissions?.contents).toBe('read')
  })
})

describe('release.yml cold-start job runs measure-cold-start.mjs after npm pack', () => {
  it('contains a step that invokes scripts/measure-cold-start.mjs', () => {
    const wf = loadRelease()
    const job = wf.jobs?.['cold-start']
    const step = (job?.steps ?? []).find(
      (s) => typeof s.run === 'string' && s.run.includes('scripts/measure-cold-start.mjs'),
    )
    expect(step, 'cold-start job: scripts/measure-cold-start.mjs step missing').toBeDefined()
  })

  it('runs npm pack BEFORE measure-cold-start.mjs', () => {
    const wf = loadRelease()
    const steps = wf.jobs?.['cold-start']?.steps ?? []
    const packIdx = steps.findIndex((s) => typeof s.run === 'string' && /\bnpm pack\b/.test(s.run))
    const coldIdx = steps.findIndex(
      (s) => typeof s.run === 'string' && s.run.includes('scripts/measure-cold-start.mjs'),
    )
    expect(packIdx, 'cold-start: no `npm pack` step found').toBeGreaterThanOrEqual(0)
    expect(coldIdx, 'cold-start: no measure-cold-start.mjs step found').toBeGreaterThanOrEqual(0)
    expect(coldIdx).toBeGreaterThan(packIdx)
  })
})

describe('release.yml smoke-matrix job exercises the 4-lane runtime matrix', () => {
  it('strategy.fail-fast === false', () => {
    const wf = loadRelease()
    expect(wf.jobs?.['smoke-matrix']?.strategy?.['fail-fast']).toBe(false)
  })

  it('strategy.matrix.lane deep-equals the documented 4-lane order', () => {
    const wf = loadRelease()
    const lanes = wf.jobs?.['smoke-matrix']?.strategy?.matrix?.lane
    expect(lanes).toEqual([...EXPECTED_LANES])
  })

  it('invokes scripts/smoke-runtime-matrix.mjs with matrix.lane piped through env (no script-injection sink)', () => {
    const wf = loadRelease()
    const steps = wf.jobs?.['smoke-matrix']?.steps ?? []
    const laneStep = steps.find(
      (s) =>
        typeof s.run === 'string' &&
        s.run.includes('scripts/smoke-runtime-matrix.mjs') &&
        s.run.includes('--lane="$LANE"'),
    )
    expect(
      laneStep,
      'smoke-matrix: step running smoke-runtime-matrix.mjs with --lane="$LANE" missing',
    ).toBeDefined()
    // matrix.lane MUST be passed via env block, not interpolated directly into run:
    expect(laneStep?.env?.LANE).toBe('${{ matrix.lane }}')
    // The run: block must NOT contain `${{ matrix.lane }}` — that's the
    // GitHub Actions script-injection sink we're avoiding.
    expect(laneStep?.run).not.toContain('${{ matrix.lane }}')
  })

  it('wires LINEAR_TEST_API_KEY, CODEX_TEST_API_KEY, GEMINI_TEST_API_KEY from secrets.*', () => {
    const wf = loadRelease()
    const env = wf.jobs?.['smoke-matrix']?.env ?? {}
    expect(env.LINEAR_TEST_API_KEY).toBe('${{ secrets.LINEAR_TEST_API_KEY }}')
    expect(env.CODEX_TEST_API_KEY).toBe('${{ secrets.CODEX_TEST_API_KEY }}')
    expect(env.GEMINI_TEST_API_KEY).toBe('${{ secrets.GEMINI_TEST_API_KEY }}')
  })

  it('smoke-matrix has read-only contents permission', () => {
    const wf = loadRelease()
    expect(wf.jobs?.['smoke-matrix']?.permissions?.contents).toBe('read')
  })
})

describe('release.yml publish job: provenance, OIDC trusted publishing (no token)', () => {
  it('has id-token: write (MANDATORY for OIDC provenance)', () => {
    const wf = loadRelease()
    expect(wf.jobs?.publish?.permissions?.['id-token']).toBe('write')
  })

  it('has contents: read', () => {
    const wf = loadRelease()
    expect(wf.jobs?.publish?.permissions?.contents).toBe('read')
  })

  it('runs `npm publish --provenance --access public`', () => {
    const wf = loadRelease()
    const step = (wf.jobs?.publish?.steps ?? []).find(
      (s) =>
        typeof s.run === 'string' &&
        s.run.includes('npm publish') &&
        s.run.includes('--provenance') &&
        s.run.includes('--access public'),
    )
    expect(step, 'publish step missing `npm publish --provenance --access public`').toBeDefined()
  })

  it('publish step sets NO NODE_AUTH_TOKEN (OIDC trusted publishing replaces the token)', () => {
    const wf = loadRelease()
    const step = (wf.jobs?.publish?.steps ?? []).find(
      (s) => typeof s.run === 'string' && s.run.includes('npm publish'),
    )
    expect(step?.env?.NODE_AUTH_TOKEN).toBeUndefined()
  })

  it('upgrades npm to >= 11.5.1 before publishing (OIDC trusted-publishing requirement)', () => {
    const wf = loadRelease()
    const step = (wf.jobs?.publish?.steps ?? []).find(
      (s) => typeof s.run === 'string' && s.run.includes('npm install -g npm'),
    )
    expect(step, 'publish job missing the npm upgrade step required for OIDC').toBeDefined()
  })

  it("setup-node@v4 in publish job uses registry-url 'https://registry.npmjs.org'", () => {
    const wf = loadRelease()
    const setupNode = (wf.jobs?.publish?.steps ?? []).find((s) =>
      s.uses?.startsWith('actions/setup-node@'),
    )
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org')
  })
})

describe('release.yml: every npm script referenced in run-strings exists in package.json', () => {
  it('every `npm run <script>` resolves to a defined script', () => {
    const wf = loadRelease()
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    const allRuns = Object.values(wf.jobs ?? {}).flatMap((job) =>
      (job?.steps ?? []).flatMap((s) =>
        typeof s.run === 'string' ? collectNpmRunNames(s.run) : [],
      ),
    )
    expect(allRuns.length).toBeGreaterThan(0)
    for (const scriptName of allRuns) {
      expect(scripts[scriptName], `package.json missing script: ${scriptName}`).toBeTruthy()
    }
  })
})
