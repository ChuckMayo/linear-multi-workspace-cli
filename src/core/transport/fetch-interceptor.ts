/**
 * Fetch interceptor for capturing Linear's complexity-meter response headers
 * (Phase 2 PLAN 02-01, RAT-02).
 *
 * Linear surfaces rate-limit pressure on every successful response via:
 *   - `x-complexity` (cost of this query)
 *   - `x-ratelimit-complexity-remaining` (remaining budget in window)
 *
 * The SDK does not expose these headers via its public API, so the only
 * lever to surface them in our envelope is patching `globalThis.fetch` for
 * the lifetime of the SDK call. To stay safe under concurrent invocations
 * (parallel workspace add/replace-token, parallel agents), the patched
 * fetch's "last response" state lives in an `AsyncLocalStorage` context —
 * each `withFetchInterception(fn)` call gets its own ALS frame.
 *
 * Snapshot-drift safety (see RESEARCH § Pitfall 8):
 * `getLastComplexity()` returns `undefined` whenever no patched fetch has
 * observed a response — typically because tests mock at the SDK class
 * boundary (vi.mock('@linear/sdk')) and never go through `globalThis.fetch`.
 * Runtimes spread `meta.complexity` only when the value is present:
 *   `...(getLastComplexity() && { complexity: getLastComplexity() })`
 * This keeps Phase 1 snapshots byte-identical: the spread is a no-op in
 * mocked tests, so `meta.complexity` is absent from the serialized envelope.
 *
 * Restoration invariant: the original `globalThis.fetch` is restored in a
 * `finally` block. Even if `fn` throws, the global is restored to the
 * captured `original` reference (Test 17). The patch is also nested-safe:
 * each `withFetchInterception` saves the current fetch (which may itself be
 * a previous patch) and restores it on exit.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

interface ComplexityCtx {
  last?: { cost: number; remaining: number }
}

const als = new AsyncLocalStorage<ComplexityCtx>()

export interface ComplexityMeta {
  cost: number
  remaining: number
}

/**
 * Read the most-recent complexity headers captured inside the current
 * `withFetchInterception(fn)` ALS frame. Returns `undefined` when the
 * interceptor was never engaged (e.g. SDK-mocked unit tests) or no fetch
 * response carried the headers.
 */
export function getLastComplexity(): ComplexityMeta | undefined {
  return als.getStore()?.last
}

/**
 * Marker we attach to our patched fetch so nested `withFetchInterception`
 * calls can recognise an existing patch and reuse the *real* fetch
 * underneath rather than chaining writes into the wrong ALS frame.
 *
 * Without this, two parallel `withFetchInterception(fnA), withFetchInterception(fnB)`
 * would chain patches: B's patched fetch → A's patched fetch → real fetch.
 * A's closure-captured `ctx` would receive writes from B's responses,
 * breaking ALS isolation. The marker lets B's patch detect that the current
 * `globalThis.fetch` is already a patch and skip past it to whatever it
 * wraps — so each patch sits between the **real** fetch and exactly the
 * `fn` call tree it was created for.
 */
const PATCH_MARKER = Symbol.for('linmux.fetch-interceptor.patch')
const RAW_FETCH_KEY = Symbol.for('linmux.fetch-interceptor.rawFetch')

interface PatchedFetch {
  (...args: Parameters<typeof fetch>): ReturnType<typeof fetch>
  [PATCH_MARKER]?: true
  [RAW_FETCH_KEY]?: typeof fetch
}

function unwrapToRealFetch(f: typeof fetch): typeof fetch {
  const cursor = f as PatchedFetch
  if (cursor[PATCH_MARKER] === true && cursor[RAW_FETCH_KEY] !== undefined) {
    return cursor[RAW_FETCH_KEY]
  }
  return f
}

/**
 * Run `fn` with `globalThis.fetch` patched so that every response within
 * `fn`'s call tree updates the ALS-scoped "last complexity" record for
 * THIS frame only. The original fetch is restored unconditionally (success
 * or throw).
 *
 * Concurrent invocations are isolated via `AsyncLocalStorage`. The patch
 * itself reads `als.getStore()` on each call — so even if two parallel
 * frames share the same global patch via interleaved scheduling, each
 * fetch's complexity write lands in the ALS frame whose `fn` is currently
 * on the stack (not the closure-captured ctx of whichever patch happens to
 * be the "outermost" wrapper).
 */
export async function withFetchInterception<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: ComplexityCtx = {}
  return als.run(ctx, async () => {
    const previous = globalThis.fetch
    const realFetch = unwrapToRealFetch(previous)
    const patched: PatchedFetch = async (...args: Parameters<typeof fetch>) => {
      const res = await realFetch(...args)
      const cost = parseHeaderInt(res.headers.get('x-complexity'))
      const remaining = parseHeaderInt(res.headers.get('x-ratelimit-complexity-remaining'))
      if (cost !== undefined && remaining !== undefined) {
        const store = als.getStore()
        if (store) store.last = { cost, remaining }
      }
      return res
    }
    patched[PATCH_MARKER] = true
    patched[RAW_FETCH_KEY] = realFetch
    globalThis.fetch = patched as typeof fetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = previous
    }
  })
}

function parseHeaderInt(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
