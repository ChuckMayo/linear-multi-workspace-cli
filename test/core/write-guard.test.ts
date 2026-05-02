import { describe, expect, it } from 'vitest'

import { LinearAgentError } from '@/core/errors/index.js'
import type { ResolvedWorkspace } from '@/core/workspace/types.js'
import { requireExplicitWorkspaceForWrite } from '@/core/workspace/write-guard.js'

/**
 * Truth table for requireExplicitWorkspaceForWrite (WSP-06):
 *
 *   source         | allowActiveOptIn | result
 *   ---------------|------------------|------------------
 *   flag           | false            | OK (explicit)
 *   env            | false            | OK (explicit)
 *   api-key-env    | false            | OK (token == selector)
 *   active         | false            | THROW
 *   single         | false            | THROW
 *   active         | true             | OK (caller opted in)
 *   single         | true             | OK (caller opted in)
 */

const NAMED_ENTRY = {
  name: 'acme',
  token: 'lin_api_acme',
  organizationId: 'org-acme',
}

function withSource(source: Exclude<ResolvedWorkspace['source'], 'api-key-env'>): ResolvedWorkspace {
  return { ...NAMED_ENTRY, source }
}

const API_KEY_ENV: ResolvedWorkspace = {
  name: null,
  token: 'lin_api_envkey',
  organizationId: null,
  source: 'api-key-env',
}

describe('requireExplicitWorkspaceForWrite', () => {
  it('Test 1: source=flag returns void (no throw)', () => {
    expect(() => requireExplicitWorkspaceForWrite(withSource('flag'), false)).not.toThrow()
  })

  it('Test 2: source=env returns void (no throw)', () => {
    expect(() => requireExplicitWorkspaceForWrite(withSource('env'), false)).not.toThrow()
  })

  it('Test 3: source=api-key-env returns void (token is selector)', () => {
    expect(() => requireExplicitWorkspaceForWrite(API_KEY_ENV, false)).not.toThrow()
  })

  it('Test 4: source=active without opt-in throws WORKSPACE_REQUIRED_FOR_WRITE', () => {
    try {
      requireExplicitWorkspaceForWrite(withSource('active'), false)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
    }
  })

  it('Test 5: source=single without opt-in throws WORKSPACE_REQUIRED_FOR_WRITE', () => {
    try {
      requireExplicitWorkspaceForWrite(withSource('single'), false)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      expect((e as LinearAgentError).code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
    }
  })

  it('Test 6: source=active WITH opt-in returns void', () => {
    expect(() => requireExplicitWorkspaceForWrite(withSource('active'), true)).not.toThrow()
  })

  it('Test 7: source=single WITH opt-in returns void', () => {
    expect(() => requireExplicitWorkspaceForWrite(withSource('single'), true)).not.toThrow()
  })

  it('Test 8: thrown error includes workspace name + remediation referencing all three opt-ins', () => {
    try {
      requireExplicitWorkspaceForWrite(withSource('active'), false)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LinearAgentError)
      const err = e as LinearAgentError
      expect(err.code).toBe('WORKSPACE_REQUIRED_FOR_WRITE')
      expect(err.details).toBeDefined()
      const details = err.details as {
        resolvedWorkspace?: string | null
        resolvedFrom?: string
        remediation?: string
      }
      expect(details.resolvedWorkspace).toBe('acme')
      expect(details.resolvedFrom).toBe('active')
      expect(details.remediation).toMatch(/--workspace/)
      expect(details.remediation).toMatch(/LINEAR_WORKSPACE/)
      expect(details.remediation).toMatch(/--allow-active-workspace-write/)
    }
  })
})
