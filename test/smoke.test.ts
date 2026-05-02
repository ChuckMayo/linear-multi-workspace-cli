import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'

const BIN = 'bin/run.js'

describe('phase-0 smoke test', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
  })

  it('node bin/run.js --help exits 0 and mentions linear-agent', () => {
    const out = execFileSync('node', [BIN, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/linear-agent/i)
  })

  it('hello command runs in --json mode and emits a JSON object with ok=true', () => {
    const out = execFileSync('node', [BIN, 'hello', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(out.trim())
    expect(parsed.ok).toBe(true)
  })
})
