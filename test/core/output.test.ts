import { beforeAll, describe, expect, it } from 'vitest'
import { LinearAgentError } from '@/core/errors/index.js'
import { failure, format, success } from '@/core/output/index.js'

beforeAll(() => {
  // Strip ANSI codes from picocolors so the snapshots are portable.
  process.env.NO_COLOR = '1'
})

describe('success() envelope', () => {
  it('returns the locked shape with stable key order: empty issue list', () => {
    const env = success(
      { issues: [] },
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    expect(JSON.stringify(env)).toMatchInlineSnapshot(
      `"{"$apiVersion":"1","ok":true,"data":{"issues":[]},"meta":{"command":"issue list","workspace":"acme","workspaceSource":"flag"}}"`,
    )
  })

  it('includes pageInfo in meta when provided', () => {
    const env = success(
      { issues: [{ id: 'iss_1', identifier: 'ENG-1' }] },
      {
        command: 'issue list',
        workspace: 'acme',
        workspaceSource: 'active',
        pageInfo: {
          hasNextPage: true,
          endCursor: 'abc',
          hasPreviousPage: false,
          startCursor: null,
        },
      },
    )
    expect(env).toMatchSnapshot()
    expect(JSON.stringify(env)).toContain('"pageInfo"')
  })

  it('handles data: null (used by mutation commands later)', () => {
    const env = success(null, {
      command: 'workspace use',
      workspace: 'acme',
      workspaceSource: 'flag',
    })
    expect(env).toMatchSnapshot()
  })

  it('omits undefined optional fields from meta', () => {
    const env = success({ ok: 1 }, { command: 'workspace list' })
    const json = JSON.stringify(env)
    expect(json).not.toContain('"workspace":')
    expect(json).not.toContain('"workspaceSource":')
    expect(json).not.toContain('"pageInfo":')
    // Phase 3 PLAN 03-01: batch must also be omitted when undefined.
    expect(json).not.toContain('"batch":')
  })

  // ─── Phase 3 PLAN 03-01 Test 5 — Meta.batch serialization ─────────────
  it('Phase 3 Test 5a: meta.batch is serialized when populated', () => {
    const env = success(
      { plan: [{ operation: 'IssueUpdate', kind: 'mutation' }] },
      {
        command: 'raw batch',
        workspace: 'acme',
        workspaceSource: 'flag',
        batch: { count: 1, kinds: { query: 0, mutation: 1 } },
      },
    )
    const json = JSON.stringify(env)
    expect(json).toContain('"batch":')
    expect(json).toContain('"count":1')
    expect(json).toContain('"kinds":{"query":0,"mutation":1}')
  })

  it('Phase 3 Test 5b: omitting batch keeps Phase 1/2 envelope byte-identical', () => {
    // The exact byte sequence below is what Phase 1/2 commands produce; the
    // Meta.batch addition MUST be invisible in this case.
    const env = success(
      { issues: [] },
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    expect(JSON.stringify(env)).toBe(
      '{"$apiVersion":"1","ok":true,"data":{"issues":[]},"meta":{"command":"issue list","workspace":"acme","workspaceSource":"flag"}}',
    )
  })
})

describe('failure() envelope — one fixture per error code in the taxonomy', () => {
  it('snapshot: WORKSPACE_NOT_RESOLVED (exit 10)', () => {
    const env = failure(LinearAgentError.workspace.notResolved('no workspace selected'), {
      command: 'issue list',
    })
    expect(env).toMatchSnapshot()
  })

  it('snapshot: AUTH_INVALID (exit 11)', () => {
    const env = failure(LinearAgentError.auth.invalid('token rejected by Linear'), {
      command: 'issue list',
      workspace: 'acme',
      workspaceSource: 'flag',
    })
    expect(env).toMatchSnapshot()
  })

  it('snapshot: VALIDATION_FAILED (exit 12)', () => {
    const env = failure(
      LinearAgentError.validation.failed('field "title" is required', { field: 'title' }),
      { command: 'issue create', workspace: 'acme', workspaceSource: 'flag' },
    )
    expect(env).toMatchSnapshot()
  })

  it('snapshot: LINEAR_API_ERROR (exit 13)', () => {
    const env = failure(
      LinearAgentError.linear.apiError({
        message: 'Linear returned an error',
        details: { graphqlErrorCode: 'INTERNAL_SERVER_ERROR' },
      }),
      { command: 'issue list', workspace: 'acme', workspaceSource: 'env' },
    )
    expect(env).toMatchSnapshot()
  })

  it('snapshot: RATELIMITED (exit 14, transient: true, retryAfterMs)', () => {
    const env = failure(LinearAgentError.rateLimited(30_000, { complexityRemaining: 0 }), {
      command: 'issue list',
      workspace: 'acme',
      workspaceSource: 'active',
    })
    expect(env).toMatchSnapshot()
  })

  it('snapshot: NETWORK_ERROR (exit 15, transient: true)', () => {
    const env = failure(LinearAgentError.network('DNS resolution failed for api.linear.app'), {
      command: 'issue list',
      workspace: 'acme',
      workspaceSource: 'flag',
    })
    expect(env).toMatchSnapshot()
  })

  it('omits undefined retryAfterMs and details from the error object', () => {
    const env = failure(LinearAgentError.network('timeout'), { command: 'issue list' })
    expect(JSON.stringify(env)).not.toContain('"retryAfterMs"')
    expect(JSON.stringify(env)).not.toContain('"details"')
  })

  it('preserves transient: false on non-transient errors', () => {
    const env = failure(LinearAgentError.workspace.notResolved(), { command: 'issue list' })
    expect(env.error.transient).toBe(false)
  })
})

describe('format() — JSON path (default)', () => {
  it('emits a single JSON.stringify(envelope) + newline to stdout, no stderr', () => {
    const env = success(
      { issues: [] },
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    const out = format(env, { pretty: false })
    expect(out.stdout).toBe(`${JSON.stringify(env)}\n`)
    expect(out.stderr).toBeUndefined()
  })

  it('failure JSON path also emits to stdout only', () => {
    const env = failure(LinearAgentError.workspace.notResolved(), { command: 'issue list' })
    const out = format(env, { pretty: false })
    expect(out.stdout.endsWith('\n')).toBe(true)
    expect(out.stdout).toContain('"ok":false')
    expect(out.stderr).toBeUndefined()
  })

  it('snapshot: success JSON output', () => {
    const env = success(
      { issues: [{ id: 'iss_1', identifier: 'ENG-1', title: 'first' }] },
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    expect(format(env, { pretty: false }).stdout).toMatchSnapshot()
  })

  it('snapshot: failure JSON output', () => {
    const env = failure(LinearAgentError.linear.apiError({ message: 'server error' }), {
      command: 'issue list',
      workspace: 'acme',
      workspaceSource: 'flag',
    })
    expect(format(env, { pretty: false }).stdout).toMatchSnapshot()
  })
})

describe('format() — pretty path', () => {
  it('snapshot: success-pretty includes workspace and command path', () => {
    const env = success(
      { issues: [] },
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    const out = format(env, { pretty: true })
    expect(out.stdout).toMatchSnapshot()
    expect(out.stdout).toContain('acme')
    expect(out.stdout).toContain('issue list')
    expect(out.stderr).toBeUndefined()
  })

  it('snapshot: failure-pretty includes code, message, and one-liner stderr summary', () => {
    const env = failure(LinearAgentError.linear.apiError({ message: 'request failed' }), {
      command: 'issue list',
      workspace: 'acme',
      workspaceSource: 'flag',
    })
    const out = format(env, { pretty: true })
    expect(out.stdout).toMatchSnapshot('failure-pretty stdout')
    expect(out.stderr).toBeDefined()
    expect(out.stderr).toMatchSnapshot('failure-pretty stderr')
    expect(out.stderr).toContain('LINEAR_API_ERROR')
    expect(out.stderr).toContain('request failed')
    expect(out.stderr?.endsWith('\n')).toBe(true)
  })
})

describe('format() — token redaction wiring', () => {
  it('scrubs PAT-shaped substrings from details before serialization', () => {
    const env = failure(
      LinearAgentError.linear.apiError({
        message: 'request failed',
        details: { rawHeader: 'Authorization: lin_api_abc123_secret' },
      }),
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    const out = format(env, { pretty: false })
    expect(out.stdout).not.toContain('lin_api_abc123_secret')
    expect(out.stdout).toContain('[REDACTED]')
  })

  it('also scrubs PAT-shaped substrings from pretty stderr summary', () => {
    // Manufacture an envelope where the *user-visible* path ends up with a
    // token (e.g. caller appended raw header to error.details, not message).
    const env = failure(
      LinearAgentError.linear.apiError({
        message: 'request failed',
        details: { Authorization: 'Bearer lin_oauth_xyz_secret' },
      }),
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    const out = format(env, { pretty: true })
    expect(out.stdout).not.toContain('lin_oauth_xyz_secret')
    expect(out.stderr).not.toContain('lin_oauth_xyz_secret')
  })

  it('snapshot: failure with token in details renders [REDACTED]', () => {
    const env = failure(
      LinearAgentError.linear.apiError({
        message: 'request failed',
        details: { rawHeader: 'Authorization: lin_api_abc123' },
      }),
      { command: 'issue list', workspace: 'acme', workspaceSource: 'flag' },
    )
    expect(format(env, { pretty: false }).stdout).toMatchSnapshot()
  })
})
