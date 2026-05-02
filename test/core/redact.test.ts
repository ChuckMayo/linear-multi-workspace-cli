import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '@/core/redact/index.js'

describe('redact (string scalar)', () => {
  it('replaces a bare PAT with [REDACTED]', () => {
    expect(redact('lin_api_abc123_xyz')).toBe(REDACTED)
  })

  it('replaces an OAuth token with [REDACTED]', () => {
    expect(redact('lin_oauth_abcDEF-789')).toBe(REDACTED)
  })

  it('preserves surrounding context, replaces only the token', () => {
    expect(redact('Authorization: lin_api_abc123 user@example.com')).toBe(
      `Authorization: ${REDACTED} user@example.com`,
    )
  })

  it('replaces multiple tokens in one string', () => {
    expect(redact('a=lin_api_one b=lin_oauth_two c=lin_api_three')).toBe(
      `a=${REDACTED} b=${REDACTED} c=${REDACTED}`,
    )
  })

  it('passes through plain strings unchanged', () => {
    expect(redact('hello world')).toBe('hello world')
    expect(redact('')).toBe('')
  })
})

describe('redact (structural walk)', () => {
  it('walks objects and arrays', () => {
    const input = {
      a: 'lin_api_secret',
      b: { c: 'lin_oauth_token2' },
      d: ['plain', 'lin_api_third'],
    }
    expect(redact(input)).toEqual({
      a: REDACTED,
      b: { c: REDACTED },
      d: ['plain', REDACTED],
    })
  })

  it('does not mutate the input object', () => {
    const input = { token: 'lin_api_secret' }
    const before = JSON.stringify(input)
    redact(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('preserves non-string types byte-for-byte', () => {
    const input = {
      n: 42,
      f: 3.14,
      b: true,
      bf: false,
      nl: null,
      u: undefined,
    }
    expect(redact(input)).toEqual(input)
  })

  it('preserves array vs object structure', () => {
    expect(Array.isArray(redact(['a', 'b']))).toBe(true)
    expect(Array.isArray(redact({ '0': 'a' }))).toBe(false)
  })

  it('preserves key ordering for objects', () => {
    const input = { z: 1, a: 'lin_api_x', m: 2 }
    expect(Object.keys(redact(input))).toEqual(['z', 'a', 'm'])
  })

  it('redacts inside a full failure-envelope shape', () => {
    const failure = {
      $apiVersion: '1',
      ok: false,
      error: {
        code: 'LINEAR_API_ERROR',
        message: 'request failed',
        transient: false,
        details: {
          rawHeader: 'Authorization: lin_api_abc123',
          path: 'lin_api_xyz/foo',
        },
      },
      meta: { command: 'issue list', workspace: 'acme' },
    }
    const out = redact(failure)
    expect(JSON.stringify(out)).not.toContain('lin_api_')
    expect(out.error.details.rawHeader).toBe(`Authorization: ${REDACTED}`)
    expect(out.error.details.path).toBe(`${REDACTED}/foo`)
  })
})

describe('redact (cyclic structures)', () => {
  it('does not infinite-loop on a self-referential object', () => {
    type Cyclic = { a: string; self?: Cyclic }
    const x: Cyclic = { a: 'lin_api_x' }
    x.self = x
    const out = redact(x) as { a: string; self: unknown }
    expect(out.a).toBe(REDACTED)
    // Second visit should be replaced by a sentinel rather than recursing.
    expect(out.self).toBe('[CIRCULAR]')
  })

  it('handles cycles inside arrays', () => {
    const arr: unknown[] = ['lin_api_x']
    arr.push(arr)
    const out = redact(arr) as unknown[]
    expect(out[0]).toBe(REDACTED)
    expect(out[1]).toBe('[CIRCULAR]')
  })
})

describe('redact (property-based)', () => {
  it('no PAT-shaped substring survives a round-trip through JSON.stringify (200+ cases)', () => {
    // Generator: arbitrary trees of {object, array, string, number, bool, null}
    // with at least one string biased toward looking like a Linear PAT.
    const tokenLike = fc.stringMatching(/^lin_(?:api|oauth)_[A-Za-z0-9_-]{8,40}$/)
    const plainString = fc.string()
    const someString = fc.oneof(
      { weight: 1, arbitrary: tokenLike },
      { weight: 3, arbitrary: plainString },
      // Embed a token inside a longer string to exercise the regex's
      // substring-match (not just full-string-match) behavior.
      {
        weight: 1,
        arbitrary: fc.tuple(plainString, tokenLike, plainString).map(([a, b, c]) => `${a}${b}${c}`),
      },
    )

    const leaf = fc.oneof(
      someString,
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.boolean(),
      fc.constant(null),
    )

    const tree = fc.letrec((rec) => ({
      tree: fc.oneof(
        { maxDepth: 4 },
        { weight: 5, arbitrary: leaf },
        { weight: 1, arbitrary: fc.array(rec('tree'), { maxLength: 5 }) },
        {
          weight: 1,
          arbitrary: fc.dictionary(fc.string({ minLength: 1 }), rec('tree'), { maxKeys: 5 }),
        },
      ),
    })).tree

    fc.assert(
      fc.property(tree, (input) => {
        const redacted = redact(input)
        const serialized = JSON.stringify(redacted)
        expect(serialized).not.toMatch(/lin_api_[A-Za-z0-9_-]+/)
        expect(serialized).not.toMatch(/lin_oauth_[A-Za-z0-9_-]+/)
      }),
      { numRuns: 250 },
    )
  })

  it('does not leak tokens hidden inside Authorization-shaped header values', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/),
        fc.constantFrom('api', 'oauth'),
        (suffix, kind) => {
          const headerValue = `Bearer lin_${kind}_${suffix}`
          const out = redact({ headers: { Authorization: headerValue } })
          expect(JSON.stringify(out)).not.toContain(`lin_${kind}_`)
        },
      ),
      { numRuns: 200 },
    )
  })
})
