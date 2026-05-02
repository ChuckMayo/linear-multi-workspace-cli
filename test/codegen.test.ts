import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'graphql'
import { describe, expect, it } from 'vitest'

const SCHEMA = resolve(process.cwd(), 'schema.graphql')
const GENERATED_DIR = resolve(process.cwd(), 'src/generated')

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

describe('graphql-codegen pipeline produces TS files in src/generated/', () => {
  it('npm run codegen exits 0 and produces TS files in src/generated/', () => {
    execFileSync('npm', ['run', 'codegen'], { stdio: 'pipe' })
    expect(existsSync(GENERATED_DIR)).toBe(true)
    const files = readdirSync(GENERATED_DIR)
    // client-preset emits at least graphql.ts and gql.ts (and usually fragment-masking.ts + index.ts).
    const tsFiles = files.filter((f) => f.endsWith('.ts'))
    expect(tsFiles.length).toBeGreaterThan(0)
  })
})
