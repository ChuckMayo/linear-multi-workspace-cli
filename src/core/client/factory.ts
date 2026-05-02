import { LinearClient } from '@linear/sdk'

import type { ResolvedWorkspace } from '../workspace/types.js'

/**
 * KRN-05: a fresh `LinearClient` per CLI invocation.
 *
 * This factory is deliberately uncached. Every call constructs a new
 * `LinearClient` from the resolved token. The token-pinning bug class
 * (PITFALLS § Pitfall 2 — "stale token reused after workspace switch") is
 * impossible by construction.
 *
 * Why no caching:
 *   - Each CLI invocation is a fresh process. There is no "warm" client to
 *     reuse across invocations.
 *   - Within a single invocation, workspace is resolved exactly once at
 *     startup; we never switch mid-process.
 *   - Even if we DID cache, the cache key would have to include the resolved
 *     token — at which point the cache buys us nothing on a single-workspace
 *     invocation and is actively dangerous if a future refactor tries to
 *     share clients across workspaces.
 *
 * The SDK handles Linear's no-`Bearer ` Authorization header convention
 * internally; the caller passes `apiKey` and never touches the header.
 */
export function createLinearClient(resolved: ResolvedWorkspace): LinearClient {
  return new LinearClient({ apiKey: resolved.token })
}
