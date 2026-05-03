/**
 * Wave 0 determinism + builder-shape tests for codegen/build-operations.ts.
 *
 * Phase 3 PLAN 03-01 — these tests are RED until Task 2 lands the builder.
 *
 * Test 3 (determinism): import { buildRegistry } from the builder module
 * directly (NO child_process / NO `npm run codegen`), call it twice into two
 * separate tmpdirs, sha256-compare the produced files. This is the canonical
 * determinism gate that CI runs on every push.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type BuildRegistryOptions, buildRegistry } from '../../codegen/build-operations.js'

const REPO_ROOT = resolve(process.cwd())
const SCHEMA_PATH = resolve(REPO_ROOT, 'schema.graphql')

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function mkTmp(label: string): { outDir: string; generatedDir: string } {
  const root = mkdtempSync(join(tmpdir(), `build-ops-${label}-${randomBytes(4).toString('hex')}-`))
  const outDir = join(root, 'src', 'operations')
  const generatedDir = join(root, 'src', 'generated')
  execFileSync('mkdir', ['-p', outDir, generatedDir])
  return { outDir, generatedDir }
}

describe('codegen/build-operations.ts', () => {
  it('exports a buildRegistry function with the documented signature', () => {
    expect(typeof buildRegistry).toBe('function')
    // signature spot-check: buildRegistry(opts: BuildRegistryOptions): void
    // (TS shape verified at compile time via the import + type alias.)
    const _typecheck: BuildRegistryOptions = {
      schemaPath: SCHEMA_PATH,
      outDir: '/tmp/_unused',
      generatedDir: '/tmp/_unused',
    }
    void _typecheck
  })

  it('schema.graphql exists at the canonical repo path', () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true)
  })

  it('Test 3 (RED→GREEN) — registry build is deterministic across two tmpdirs (sha256-identical _registry.graphql)', () => {
    const a = mkTmp('A')
    const b = mkTmp('B')

    const optsA: BuildRegistryOptions = {
      schemaPath: SCHEMA_PATH,
      outDir: a.outDir,
      generatedDir: a.generatedDir,
    }
    const optsB: BuildRegistryOptions = {
      schemaPath: SCHEMA_PATH,
      outDir: b.outDir,
      generatedDir: b.generatedDir,
    }

    buildRegistry(optsA)
    buildRegistry(optsB)

    const graphqlA = join(a.outDir, '_registry.graphql')
    const graphqlB = join(b.outDir, '_registry.graphql')
    const zodA = join(a.outDir, '_registry.zod.ts')
    const zodB = join(b.outDir, '_registry.zod.ts')

    expect(existsSync(graphqlA)).toBe(true)
    expect(existsSync(graphqlB)).toBe(true)
    expect(existsSync(zodA)).toBe(true)
    expect(existsSync(zodB)).toBe(true)

    expect(sha256OfFile(graphqlA)).toBe(sha256OfFile(graphqlB))
    expect(sha256OfFile(zodA)).toBe(sha256OfFile(zodB))
  })

  it('emits the operations.ts composition file into generatedDir', () => {
    const a = mkTmp('comp')
    buildRegistry({
      schemaPath: SCHEMA_PATH,
      outDir: a.outDir,
      generatedDir: a.generatedDir,
    })
    const opsTs = join(a.generatedDir, 'operations.ts')
    expect(existsSync(opsTs)).toBe(true)
    const txt = readFileSync(opsTs, 'utf8')
    expect(txt).toContain('OPERATION_REGISTRY')
    expect(txt).toMatch(/kind:\s*'(query|mutation)'/)
  })

  it('excludes subscriptions from _registry.graphql', () => {
    const a = mkTmp('subs')
    buildRegistry({
      schemaPath: SCHEMA_PATH,
      outDir: a.outDir,
      generatedDir: a.generatedDir,
    })
    const sdl = readFileSync(join(a.outDir, '_registry.graphql'), 'utf8')
    // No top-level `subscription FooBar` operations.
    expect(/^subscription /m.test(sdl)).toBe(false)
  })
})
