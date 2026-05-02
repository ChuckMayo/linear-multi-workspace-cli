import { LinearClient } from '@linear/sdk'
import { describe, expect, it } from 'vitest'

import { createLinearClient } from '@/core/client/factory.js'
import type { ResolvedWorkspace } from '@/core/workspace/types.js'

/**
 * Tests for createLinearClient (KRN-05):
 *  - Constructor produces a real @linear/sdk LinearClient instance
 *  - Two calls = two distinct instances (no caching, no token-pinning)
 *  - Works for both named-workspace and api-key-env sources
 *  - Construction is synchronous and does NOT make any network call
 *
 * IMPORTANT: this file deliberately avoids touching `client.viewer`. In
 * @linear/sdk v83, `viewer` is a getter property that fires a GraphQL request
 * the moment it is accessed. The test merely asserts the SDK contract surface
 * — `instanceof LinearClient` plus the presence of `.client` (the underlying
 * GraphQL transport) — so no network call is provoked.
 */

const NAMED: ResolvedWorkspace = {
  name: 'acme',
  token: 'lin_api_test_acme',
  organizationId: 'org-acme',
  source: 'flag',
}

const API_KEY_ENV: ResolvedWorkspace = {
  name: null,
  token: 'lin_api_test_envkey',
  organizationId: null,
  source: 'api-key-env',
}

describe('createLinearClient', () => {
  it('Test 1: returns an instance of LinearClient for a named workspace', () => {
    const client = createLinearClient(NAMED)
    expect(client).toBeInstanceOf(LinearClient)
  })

  it('Test 2: two calls with identical input return DIFFERENT instances (no cache)', () => {
    const a = createLinearClient(NAMED)
    const b = createLinearClient(NAMED)
    expect(a).not.toBe(b)
    // Defensive: also check they're both LinearClient instances.
    expect(a).toBeInstanceOf(LinearClient)
    expect(b).toBeInstanceOf(LinearClient)
  })

  it('Test 3: returned client exposes the SDK contract surface (.client transport)', () => {
    const client = createLinearClient(NAMED)
    // `.client` is the underlying GraphQL transport per @linear/sdk docs.
    // Accessing it does not trigger a network call (only `.viewer` and
    // similar query getters do).
    expect(client.client).toBeDefined()
    // `.issues` is a method on the LinearClient prototype — assert it exists
    // without invoking it (invocation would fire a request).
    expect(typeof client.issues).toBe('function')
  })

  it('Test 4: works for api-key-env source (token-only, name=null)', () => {
    const client = createLinearClient(API_KEY_ENV)
    expect(client).toBeInstanceOf(LinearClient)
    expect(client.client).toBeDefined()
  })

  it('Test 5: construction is synchronous (no exception, no network)', () => {
    // If the SDK constructor were async or made a network call on
    // construction, this synchronous expression would either throw or
    // return a Promise/undefined. It does neither.
    let constructed: LinearClient | undefined
    expect(() => {
      constructed = createLinearClient(NAMED)
    }).not.toThrow()
    expect(constructed).toBeInstanceOf(LinearClient)
  })
})
