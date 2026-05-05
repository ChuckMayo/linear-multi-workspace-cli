/**
 * Unit tests for `scripts/smoke-runtime-matrix.mjs` (Phase 5 PLAN 05-04).
 *
 * Coverage matrix (DST-02 + DST-07):
 *   - LANES registry (4 lanes; correct blocking flags)
 *   - redact() — strips known secrets, no-ops on empty env, handles regex metachars
 *   - parseArgs() — `--lane=`, `--tarball=`, `--skill-path=`, unknown flags
 *   - runLane() with mocked spawnImpl/fsImpl/env:
 *     - plain-bash: success-with-key, no-key WORKSPACE_NOT_RESOLVED, unparseable, bad apiVersion, signal kill
 *     - claude-code-via-skill: version match success, version mismatch, missing invocation
 *     - codex-cli-via-exec: skip when env unset, run when env set
 *     - gemini-cli-via-exec: symmetric to codex
 *     - unknown lane name
 *   - --lane=all aggregation:
 *     - all blocking pass + advisory skip → ok=true
 *     - one blocking fail → ok=false
 *     - one advisory fail (mocked) → ok stays true
 *
 * All tests run offline: no real `npx` is invoked. Subprocess + fs are dependency-injected.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LANES,
  parseArgs,
  parseEnvelopeFromStdout,
  RUNTIME_PINS,
  redact,
  runLane,
} from '../../scripts/smoke-runtime-matrix.mjs'

// ───────────────────────── LANES registry ─────────────────────────

describe('LANES registry', () => {
  it('contains exactly 4 lanes', () => {
    expect(Object.keys(LANES).sort()).toEqual([
      'claude-code-via-skill',
      'codex-cli-via-exec',
      'gemini-cli-via-exec',
      'plain-bash',
    ])
  })

  it('marks plain-bash and claude-code-via-skill as blocking', () => {
    expect(LANES['plain-bash'].blocking).toBe(true)
    expect(LANES['claude-code-via-skill'].blocking).toBe(true)
  })

  it('marks codex and gemini lanes as advisory (not blocking)', () => {
    expect(LANES['codex-cli-via-exec'].blocking).toBe(false)
    expect(LANES['gemini-cli-via-exec'].blocking).toBe(false)
  })

  it('lists required env vars for advisory lanes', () => {
    expect(LANES['codex-cli-via-exec'].requires).toContain('CODEX_TEST_API_KEY')
    expect(LANES['gemini-cli-via-exec'].requires).toContain('GEMINI_TEST_API_KEY')
  })
})

describe('RUNTIME_PINS', () => {
  it('pins codex and gemini CLI invocation strings', () => {
    expect(typeof RUNTIME_PINS.codex).toBe('string')
    expect(RUNTIME_PINS.codex).toMatch(/@openai\/codex/)
    expect(typeof RUNTIME_PINS.gemini).toBe('string')
    expect(RUNTIME_PINS.gemini).toMatch(/@google\/gemini-cli/)
  })
})

// ───────────────────────── redact() ─────────────────────────

describe('redact()', () => {
  it('replaces known secret env values with [REDACTED]', () => {
    const env = { LINEAR_TEST_API_KEY: 'lin_api_secret123' }
    expect(redact('foo lin_api_secret123 bar', env)).toBe('foo [REDACTED] bar')
  })

  it('is a no-op when env vars are unset', () => {
    expect(redact('plain text', {})).toBe('plain text')
  })

  it('is a no-op when text is empty', () => {
    expect(redact('', { LINEAR_TEST_API_KEY: 'sec' })).toBe('')
    expect(redact(undefined, { LINEAR_TEST_API_KEY: 'sec' })).toBeFalsy()
  })

  it('handles secrets containing regex metacharacters', () => {
    // `.split().join()` (NOT regex) means $.\^+*?() are literals
    const env = { LINEAR_TEST_API_KEY: 'lin_api_$pecial.chars\\here' }
    expect(redact('aa lin_api_$pecial.chars\\here bb', env)).toBe('aa [REDACTED] bb')
  })

  it('redacts every supported secret env var', () => {
    const env = {
      LINEAR_TEST_API_KEY: 'aaaaaaaa',
      CODEX_TEST_API_KEY: 'bbbbbbbb',
      GEMINI_TEST_API_KEY: 'cccccccc',
      LINEAR_API_KEY: 'dddddddd',
    }
    const out = redact('aaaaaaaa bbbbbbbb cccccccc dddddddd', env)
    expect(out).not.toContain('aaaaaaaa')
    expect(out).not.toContain('bbbbbbbb')
    expect(out).not.toContain('cccccccc')
    expect(out).not.toContain('dddddddd')
  })

  it('skips secrets shorter than 8 characters (avoid false positives)', () => {
    const env = { LINEAR_TEST_API_KEY: 'short' }
    expect(redact('the word short appears', env)).toBe('the word short appears')
  })
})

// ───────────────────────── parseEnvelopeFromStdout() ─────────────────────────

describe('parseEnvelopeFromStdout()', () => {
  it('parses a single JSON envelope', () => {
    const envelope = { $apiVersion: '1', ok: true, data: { user: { id: 'u1' } } }
    expect(parseEnvelopeFromStdout(JSON.stringify(envelope))).toEqual(envelope)
  })

  it('returns null for empty input', () => {
    expect(parseEnvelopeFromStdout('')).toBeNull()
  })

  it('extracts the envelope when followed by an oclif EEXIT wrapper', () => {
    const envelope = {
      $apiVersion: '1',
      ok: false,
      error: { code: 'WORKSPACE_NOT_RESOLVED', message: 'no key' },
    }
    const oclifWrapper = '\n{\n  "error": {\n    "code": "EEXIT",\n    "oclif": { "exit": 10 }\n  }\n}'
    const stdout = JSON.stringify(envelope) + oclifWrapper
    expect(parseEnvelopeFromStdout(stdout)).toEqual(envelope)
  })

  it('returns null when stdout has no envelope-shaped JSON object', () => {
    expect(parseEnvelopeFromStdout('{"random":"object"}')).toBeNull()
  })

  it('returns null for non-JSON stdout', () => {
    expect(parseEnvelopeFromStdout('definitely not json')).toBeNull()
  })

  it('handles JSON containing escaped braces in strings', () => {
    const envelope = { $apiVersion: '1', ok: true, data: { msg: 'a {literal} brace' } }
    expect(parseEnvelopeFromStdout(JSON.stringify(envelope))).toEqual(envelope)
  })
})

// ───────────────────────── parseArgs() ─────────────────────────

describe('parseArgs()', () => {
  it('parses --lane=plain-bash', () => {
    expect(parseArgs(['--lane=plain-bash'])).toMatchObject({ lane: 'plain-bash' })
  })

  it('parses --tarball=', () => {
    expect(parseArgs(['--lane=plain-bash', '--tarball=./foo.tgz'])).toMatchObject({
      lane: 'plain-bash',
      tarball: './foo.tgz',
    })
  })

  it('parses --skill-path=', () => {
    expect(parseArgs(['--lane=plain-bash', '--skill-path=./SKILL.md'])).toMatchObject({
      skillPath: './SKILL.md',
    })
  })

  it('returns lane: undefined when --lane is missing', () => {
    expect(parseArgs([]).lane).toBeUndefined()
  })

  it('flags unknown flags', () => {
    const parsed = parseArgs(['--bogus=true'])
    expect(parsed._unknownFlags).toContain('--bogus=true')
  })

  it('parses --lane=all', () => {
    expect(parseArgs(['--lane=all'])).toMatchObject({ lane: 'all' })
  })
})

// ───────────────────────── runLane(): unknown lane ─────────────────────────

describe('runLane() — unknown lane', () => {
  it('returns ok:false with reason mentioning unknown lane', async () => {
    const result = await runLane({
      lane: 'no-such-lane',
      tarball: './foo.tgz',
      skillPath: './SKILL.md',
      spawnImpl: () => ({ status: 0, stdout: '', stderr: '', signal: null }),
      fsImpl: { readFileSync: () => '' },
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.lane).toBe('no-such-lane')
    expect(result.reason).toMatch(/unknown lane/i)
  })
})

// ───────────────────────── plain-bash lane ─────────────────────────

describe('runLane() — plain-bash', () => {
  function plainBashInputs(spawn: ReturnType<typeof vi.fn>) {
    return {
      lane: 'plain-bash',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: {},
    } as const
  }

  it('passes when stdout is a well-formed success envelope', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        $apiVersion: '1',
        ok: true,
        data: { user: { id: 'u-123' } },
      }),
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('plain-bash')
    const output = result.output as { data?: { user?: { id?: string } } } | undefined
    expect(output?.data?.user?.id).toBe('u-123')
    expect(spawn).toHaveBeenCalledTimes(1)
    // Asserts: spawnSync called with 'npx' and arg array (NOT a shell string)
    const firstCall = spawn.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [cmd, args] = firstCall as [string, string[]]
    expect(cmd).toBe('npx')
    expect(Array.isArray(args)).toBe(true)
    expect(args).toContain('--yes')
    expect(args).toContain('me')
    expect(args).toContain('--json')
  })

  it('passes when stdout is a WORKSPACE_NOT_RESOLVED failure envelope (no-key path)', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        $apiVersion: '1',
        ok: false,
        error: { code: 'WORKSPACE_NOT_RESOLVED', message: 'no key set' },
      }),
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('plain-bash')
  })

  it('passes when stdout has the envelope followed by an oclif EEXIT wrapper', async () => {
    // Real CLI on non-zero exit emits two JSON objects: our envelope, then oclif's wrapper.
    const envelope = JSON.stringify({
      $apiVersion: '1',
      ok: false,
      error: { code: 'WORKSPACE_NOT_RESOLVED', message: 'no key' },
    })
    const wrapper = '\n{\n  "error": {\n    "code": "EEXIT",\n    "oclif": { "exit": 10 }\n  }\n}\n'
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      stdout: envelope + wrapper,
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('plain-bash')
  })

  it('fails with reason /unparseable/ when stdout is not JSON', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'definitely not json',
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/unparseable/i)
  })

  it('fails with reason mentioning $apiVersion when version is wrong', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ $apiVersion: '2', ok: true }),
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/\$apiVersion/i)
  })

  it('fails with reason mentioning signal when process was killed', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/signal/i)
  })

  it('fails when envelope ok=true but data.user.id is missing', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ $apiVersion: '1', ok: true, data: {} }),
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(false)
  })

  it('fails when envelope ok=false but error.code is some other value', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        $apiVersion: '1',
        ok: false,
        error: { code: 'SOME_OTHER_ERROR', message: 'x' },
      }),
      stderr: '',
      signal: null,
    })
    const result = await runLane(plainBashInputs(spawn))
    expect(result.ok).toBe(false)
  })
})

// ───────────────────────── claude-code-via-skill lane ─────────────────────────

describe('runLane() — claude-code-via-skill', () => {
  const VALID_SKILL_BODY = `# linear-agent

Pinned version: \`9.9.9\`. Always invoke as \`npx -y linear-agent@9.9.9 me --json\`.
`
  const VALID_PKG = JSON.stringify({ name: 'linear-agent', version: '9.9.9' })

  function makeFsImpl(skillBody: string, pkgJson: string) {
    return {
      readFileSync: vi.fn((path: string) => {
        if (typeof path === 'string' && path.endsWith('package.json')) return pkgJson
        return skillBody
      }),
    }
  }

  it('passes when skill version matches package.json version and spawn succeeds', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        $apiVersion: '1',
        ok: true,
        data: { user: { id: 'u-1' } },
      }),
      stderr: '',
      signal: null,
    })
    const result = await runLane({
      lane: 'claude-code-via-skill',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: makeFsImpl(VALID_SKILL_BODY, VALID_PKG),
      env: {},
    })
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('claude-code-via-skill')
  })

  it('fails with reason /version mismatch/ when versions disagree', async () => {
    const result = await runLane({
      lane: 'claude-code-via-skill',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: vi.fn(),
      fsImpl: makeFsImpl(VALID_SKILL_BODY, JSON.stringify({ version: '9.9.8' })),
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/version mismatch/i)
  })

  it('fails when skill body has no `npx -y linear-agent@<v>` invocation', async () => {
    const noInvocation = '# linear-agent\n\nThis skill body has no proper invocation.\n'
    const result = await runLane({
      lane: 'claude-code-via-skill',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: vi.fn(),
      fsImpl: makeFsImpl(noInvocation, VALID_PKG),
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no .*invocation/i)
  })
})

// ───────────────────────── codex-cli-via-exec lane ─────────────────────────

describe('runLane() — codex-cli-via-exec', () => {
  it('skips when CODEX_TEST_API_KEY is unset', async () => {
    const spawn = vi.fn()
    const result = await runLane({
      lane: 'codex-cli-via-exec',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: {},
    })
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toMatch(/CODEX_TEST_API_KEY/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('skips when CODEX_TEST_API_KEY is empty string', async () => {
    const spawn = vi.fn()
    const result = await runLane({
      lane: 'codex-cli-via-exec',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: { CODEX_TEST_API_KEY: '' },
    })
    expect(result.skipped).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs spawn when CODEX_TEST_API_KEY is set; redacts secret from output', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      // Simulate Codex echoing the env value back into stdout
      stdout: 'Some Codex narration including secret_codex_value_xyz here',
      stderr: '',
      signal: null,
    })
    const result = await runLane({
      lane: 'codex-cli-via-exec',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: { CODEX_TEST_API_KEY: 'secret_codex_value_xyz' },
    })
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('codex-cli-via-exec')
    expect(spawn).toHaveBeenCalledTimes(1)
    // assert spawn called with arg array (no shell string)
    const firstCall = spawn.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [cmd, args] = firstCall as [string, string[]]
    expect(cmd).toBe('npx')
    expect(Array.isArray(args)).toBe(true)
    expect(args).toContain('exec')
    // assert redaction worked
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret_codex_value_xyz')
  })
})

// ───────────────────────── gemini-cli-via-exec lane ─────────────────────────

describe('runLane() — gemini-cli-via-exec', () => {
  it('skips when GEMINI_TEST_API_KEY is unset', async () => {
    const spawn = vi.fn()
    const result = await runLane({
      lane: 'gemini-cli-via-exec',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: {},
    })
    expect(result.skipped).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs spawn when GEMINI_TEST_API_KEY is set; passes -p and --output-format json', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'Gemini output...',
      stderr: '',
      signal: null,
    })
    const result = await runLane({
      lane: 'gemini-cli-via-exec',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: { readFileSync: () => '' },
      env: { GEMINI_TEST_API_KEY: 'gemini_secret_value_xyz' },
    })
    expect(result.ok).toBe(true)
    const firstCall = spawn.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [cmd, args] = firstCall as [string, string[]]
    expect(cmd).toBe('npx')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
  })
})

// ───────────────────────── --lane=all aggregation ─────────────────────────

describe('runLane() — lane=all aggregation', () => {
  const SKILL_BODY = '# linear-agent\nUse `npx -y linear-agent@9.9.9 me --json`.\n'
  const PKG = JSON.stringify({ version: '9.9.9' })

  function makeFsImpl() {
    return {
      readFileSync: (path: string) => {
        if (typeof path === 'string' && path.endsWith('package.json')) return PKG
        return SKILL_BODY
      },
    }
  }

  it('aggregates ok:true when blocking lanes pass and advisory lanes skip', async () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        $apiVersion: '1',
        ok: true,
        data: { user: { id: 'u-1' } },
      }),
      stderr: '',
      signal: null,
    })
    const result = await runLane({
      lane: 'all',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: makeFsImpl(),
      env: {}, // codex/gemini skip
    })
    expect(result.ok).toBe(true)
    expect(result.lane).toBe('all')
    expect(Array.isArray(result.lanes)).toBe(true)
    expect(result.lanes).toHaveLength(4)
    // codex + gemini should be skipped
    const codex = result.lanes?.find((l: { lane: string }) => l.lane === 'codex-cli-via-exec')
    expect(codex?.skipped).toBe(true)
    const gemini = result.lanes?.find((l: { lane: string }) => l.lane === 'gemini-cli-via-exec')
    expect(gemini?.skipped).toBe(true)
  })

  it('aggregates ok:false when a blocking lane fails', async () => {
    // plain-bash returns garbage → lane fails → aggregate fails
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'not json',
      stderr: '',
      signal: null,
    })
    const result = await runLane({
      lane: 'all',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: makeFsImpl(),
      env: {},
    })
    expect(result.ok).toBe(false)
    const plainBash = result.lanes?.find((l) => l.lane === 'plain-bash')
    expect(plainBash?.ok).toBe(false)
  })

  it('aggregate stays ok:true when an advisory lane fails', async () => {
    // Simulate: blocking lanes pass, codex returns nonzero with API key set
    let callIdx = 0
    const spawn = vi.fn().mockImplementation(() => {
      callIdx += 1
      // First two spawn calls are plain-bash + claude-code-via-skill (both succeed)
      // Third is codex (fails); fourth is gemini (skipped because GEMINI not set)
      if (callIdx <= 2) {
        return {
          status: 0,
          stdout: JSON.stringify({
            $apiVersion: '1',
            ok: true,
            data: { user: { id: 'u-1' } },
          }),
          stderr: '',
          signal: null,
        }
      }
      // codex non-zero exit
      return { status: 1, stdout: '', stderr: 'boom', signal: null }
    })
    const result = await runLane({
      lane: 'all',
      tarball: './linear-agent-9.9.9.tgz',
      skillPath: './SKILL.md',
      spawnImpl: spawn,
      fsImpl: makeFsImpl(),
      env: { CODEX_TEST_API_KEY: 'cccccccc' }, // gemini still unset → skipped
    })
    // Aggregate should still be ok=true: advisory failure doesn't poison
    expect(result.ok).toBe(true)
    const codex = result.lanes?.find((l) => l.lane === 'codex-cli-via-exec')
    expect(codex?.ok).toBe(false) // codex itself failed, but advisory
  })
})
