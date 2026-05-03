/**
 * Unit tests for `withFetchInterception` and `getLastComplexity`
 * (Phase 2 PLAN 02-01 Task 1, RAT-02).
 *
 * Strategy: every test temporarily replaces `globalThis.fetch` with a
 * `vi.fn()` controlled by the test, then asserts that the wrapper:
 *   - patches and restores `globalThis.fetch` correctly,
 *   - captures `x-complexity` and `x-ratelimit-complexity-remaining`
 *     into the ALS context,
 *   - isolates parallel `withFetchInterception(fn)` calls.
 *
 * No SDK mock needed — this layer is a pure Node 22+ Fetch API exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLastComplexity, withFetchInterception } from '@/core/transport/fetch-interceptor.js'

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(headers: Record<string, string> = {}): Response {
  return new Response('{"data":{}}', {
    status: 200,
    headers: new Headers(headers),
  })
}

describe('withFetchInterception', () => {
  it('Test 16 (RED): patches globalThis.fetch for the lifetime of fn and restores on success', async () => {
    const stub = vi.fn().mockResolvedValue(jsonResponse())
    globalThis.fetch = stub as unknown as typeof globalThis.fetch
    const baseline = globalThis.fetch
    let inside: typeof globalThis.fetch | undefined

    await withFetchInterception(async () => {
      inside = globalThis.fetch
      // Make a fetch call so the patch's wrapping logic runs.
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
    })

    expect(inside).not.toBe(baseline)
    expect(globalThis.fetch).toBe(baseline)
  })

  it('Test 17: restores globalThis.fetch even when fn throws', async () => {
    const stub = vi.fn().mockResolvedValue(jsonResponse())
    globalThis.fetch = stub as unknown as typeof globalThis.fetch
    const baseline = globalThis.fetch

    await expect(
      withFetchInterception(async () => {
        throw new Error('boom inside fn')
      }),
    ).rejects.toThrow('boom inside fn')

    expect(globalThis.fetch).toBe(baseline)
  })

  it('Test 18: captures x-complexity and x-ratelimit-complexity-remaining into ALS', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        'x-complexity': '42',
        'x-ratelimit-complexity-remaining': '2500',
      }),
    ) as unknown as typeof globalThis.fetch

    const observed = await withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
      return getLastComplexity()
    })

    expect(observed).toEqual({ cost: 42, remaining: 2500 })
  })

  it('Test 19: returns undefined when complexity headers are absent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse()) as unknown as typeof globalThis.fetch

    const observed = await withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
      return getLastComplexity()
    })

    expect(observed).toBeUndefined()
  })

  it('Test 20: when multiple fetches happen, getLastComplexity reflects the LAST response headers', async () => {
    let call = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++
      if (call === 1) {
        return jsonResponse({
          'x-complexity': '10',
          'x-ratelimit-complexity-remaining': '90',
        })
      }
      return jsonResponse({
        'x-complexity': '7',
        'x-ratelimit-complexity-remaining': '83',
      })
    }) as unknown as typeof globalThis.fetch

    const observed = await withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
      return getLastComplexity()
    })

    expect(observed).toEqual({ cost: 7, remaining: 83 })
  })

  it('Test 21: parallel withFetchInterception(fn) calls do NOT see each other (ALS isolation)', async () => {
    // First branch: respond with cost=10/remaining=100; gate after fetch so the
    // second branch can start before this one finishes.
    let releaseSecond!: () => void
    const secondStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })

    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('first')) {
        return jsonResponse({
          'x-complexity': '10',
          'x-ratelimit-complexity-remaining': '100',
        })
      }
      return jsonResponse({
        'x-complexity': '99',
        'x-ratelimit-complexity-remaining': '1',
      })
    }) as unknown as typeof globalThis.fetch

    const branchA = withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/first')
      // Yield so branch B's fetch interleaves between A's two reads.
      await secondStarted
      return getLastComplexity()
    })

    const branchB = withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/second')
      const observed = getLastComplexity()
      releaseSecond()
      return observed
    })

    const [a, b] = await Promise.all([branchA, branchB])
    expect(a).toEqual({ cost: 10, remaining: 100 })
    expect(b).toEqual({ cost: 99, remaining: 1 })
  })

  it('Test 22: non-numeric header values yield undefined (not partial NaN object)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        'x-complexity': 'NaN-shaped',
        'x-ratelimit-complexity-remaining': 'also-bad',
      }),
    ) as unknown as typeof globalThis.fetch

    const observed = await withFetchInterception(async () => {
      await globalThis.fetch('https://api.linear.app/graphql', { method: 'POST' })
      return getLastComplexity()
    })

    expect(observed).toBeUndefined()
  })
})
