import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'graphql'
import { describe, expect, it } from 'vitest'

const SCHEMA = resolve(process.cwd(), 'schema.graphql')

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('schema.graphql is vendored, valid, and deterministic', () => {
  it('schema.graphql exists and is non-trivially sized', () => {
    expect(existsSync(SCHEMA)).toBe(true)
    const stat = statSync(SCHEMA)
    expect(stat.size).toBeGreaterThan(10_000)
  })

  it('schema.graphql parses as valid GraphQL SDL with a Query root', () => {
    const sdl = readFileSync(SCHEMA, 'utf8')
    const ast = parse(sdl)
    expect(ast.definitions.length).toBeGreaterThan(0)
    const hasQuery = ast.definitions.some((d) => 'name' in d && d.name?.value === 'Query')
    expect(hasQuery).toBe(true)
  })

  it('npm run fetch-schema is idempotent (deterministic byte-identical output)', () => {
    const before = sha256(SCHEMA)
    execFileSync('npm', ['run', 'fetch-schema'], { stdio: 'pipe' })
    const after = sha256(SCHEMA)
    expect(after).toBe(before)
  })
})
