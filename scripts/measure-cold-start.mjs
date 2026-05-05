#!/usr/bin/env node
/**
 * measure-cold-start.mjs — DST-03 release-blocking budget gate.
 *
 * Times N=5 invocations of `npx --yes file:./<tarball> --version` via
 * `node:child_process.spawnSync` (NEVER `exec` — safe-API only) and reports the
 * MEDIAN wall-clock time. Exits 0 if median ≤ budget, 1 otherwise.
 *
 * Why median (not min/avg/max): GitHub Actions runners have variable load.
 * Across N=5 runs median is the most stable signal. Min understates the
 * realistic worst-case; max is dominated by runner contention. (CONTEXT.md +
 * RESEARCH §3.)
 *
 * Why N=5: 1 is noisy, 10 is wasteful. 5 is the standard `hyperfine`-style
 * sweet spot for sub-second commands. (CONTEXT.md + RESEARCH §3.)
 *
 * Why `npx --yes file:./<tarball>` (vs registry install): RESEARCH §2 — the
 * `file:` form ALWAYS installs fresh into a temp dir (no cache hits), so this
 * measurement is a STRICT UPPER BOUND on the registry path. Budget is
 * conservative, which is what we want for release gating.
 *
 * Why `--version` (vs a real command): the simplest no-op the CLI exposes.
 * Measures the load cost of `bin/run.js` + `dist/index.js` + oclif's manifest
 * resolution, without paying for any specific command's setup. (CONTEXT.md.)
 *
 * Stdout (single JSON line — agent-parseable):
 *   { "ok": bool, "runs_ms": [n, n, ...], "median_ms": n, "budget_ms": n, "tarball": "..." }
 *
 * Stderr:
 *   - per-run progress: `run K/N: <ms>ms`
 *   - on budget violation: `COLD_START_BUDGET_EXCEEDED: median=Xms threshold=Yms`
 *     plus all raw timings for diagnosis (RESEARCH §11).
 *
 * Exit codes:
 *   - 0: median ≤ budget AND every spawn exited cleanly.
 *   - 1: median > budget OR any spawn returned non-zero OR tarball not found
 *     OR flag parsing failed.
 *
 * SAFETY: Subprocess invocation uses `spawnSync` with arg arrays. Tarball path
 * is admitted only via flag (no env-var, no shell substring), and findTarball
 * filters via `^linear-agent-.*\.tgz$` regex — no shell metacharacters can
 * survive into the spawn call. (Threat T-05-03-T mitigation.)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const TARBALL_PATTERN = /^linear-agent-.*\.tgz$/
const MAX_RUNS = 100 // T-05-03-D: clamp to prevent runaway spawns.

/**
 * Sort ascending, return the middle element (or the average of the middle two
 * for even-length input). Throws on empty input — empty is a programmer error,
 * not 0 / NaN.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median() requires a non-empty array')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Assemble the JSON result envelope. `ok` is derived from `median_ms <= budget_ms`.
 */
export function buildResult({ runs_ms, budget_ms, tarball }) {
  const median_ms = median(runs_ms)
  return {
    ok: median_ms <= budget_ms,
    runs_ms,
    median_ms,
    budget_ms,
    tarball,
  }
}

/**
 * Discover the most-recently-modified `linear-agent-*.tgz` in `cwd`. Returns
 * the absolute path, or `null` if no matching file exists. Files not matching
 * `^linear-agent-.*\.tgz$` are ignored (so `linear-agent.tgz` and
 * `linear-agent-0.0.0.tgz.bak` are ignored).
 */
export function findTarball(cwd) {
  let entries
  try {
    entries = readdirSync(cwd)
  } catch {
    return null
  }
  const matches = entries.filter((f) => TARBALL_PATTERN.test(f))
  if (matches.length === 0) return null
  let best = null
  let bestMtime = -Infinity
  for (const f of matches) {
    const path = join(cwd, f)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.mtimeMs > bestMtime) {
      best = path
      bestMtime = st.mtimeMs
    }
  }
  return best
}

/**
 * Hand-rolled flag parser. Accepts `--key=value` and `--key value`.
 * Defaults: budget_ms=500, runs=5. tarball is undefined (caller resolves).
 *
 * Throws on:
 *   - non-numeric / negative / zero / >MAX_RUNS values for --runs
 *   - non-numeric / negative values for --budget-ms
 *   - --runs=0 (a single measurement is a useful diagnostic, but zero is meaningless)
 */
export function parseArgs(argv) {
  const out = { tarball: undefined, budget_ms: 500, runs: 5 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let key
    let value
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=')
      key = arg.slice(2, eq)
      value = arg.slice(eq + 1)
    } else if (arg.startsWith('--')) {
      key = arg.slice(2)
      value = argv[i + 1]
      i++
    } else {
      throw new Error(`measure-cold-start: unexpected positional arg: ${arg}`)
    }
    if (key === 'tarball') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('measure-cold-start: --tarball requires a non-empty path')
      }
      out.tarball = value
    } else if (key === 'budget-ms') {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`measure-cold-start: --budget-ms must be a non-negative number, got "${value}"`)
      }
      out.budget_ms = n
    } else if (key === 'runs') {
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`measure-cold-start: --runs must be a positive integer, got "${value}"`)
      }
      if (n > MAX_RUNS) {
        throw new Error(`measure-cold-start: --runs=${n} exceeds clamp of ${MAX_RUNS} (DoS guard)`)
      }
      out.runs = n
    } else {
      throw new Error(`measure-cold-start: unknown flag --${key}`)
    }
  }
  return out
}

/**
 * Time one `npx --yes file:<tarball> --version` invocation. Throws on non-zero
 * exit so the caller sees a budget failure as an exception, not silently as a
 * misleading 0ms timing.
 */
function timedRun(tarballPath) {
  const start = performance.now()
  const result = spawnSync('npx', ['--yes', `file:${tarballPath}`, '--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  const ms = performance.now() - start
  if (result.error) {
    throw new Error(`npx spawn failed: ${result.error.message ?? result.error}`)
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 500)
    throw new Error(`npx exited ${result.status}; stderr: ${stderr}`)
  }
  return ms
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message ?? err}\n`)
    process.exit(1)
  }

  const cwd = process.cwd()

  // Resolve tarball: explicit flag wins; otherwise auto-discover.
  let tarballPath
  if (args.tarball) {
    tarballPath = resolve(cwd, args.tarball)
    let exists = false
    try {
      statSync(tarballPath)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      process.stderr.write(
        `measure-cold-start: tarball not found at ${args.tarball} (resolved to ${tarballPath})\n`,
      )
      process.exit(1)
    }
  } else {
    const found = findTarball(cwd)
    if (!found) {
      process.stderr.write(
        `measure-cold-start: no linear-agent-*.tgz found in ${cwd}; run 'npm pack' first\n`,
      )
      process.exit(1)
    }
    tarballPath = found
  }

  if (args.runs === 1) {
    process.stderr.write(
      'measure-cold-start: warning — --runs=1 is a diagnostic single-shot; not a release-gate signal\n',
    )
  }

  const runs_ms = []
  for (let i = 0; i < args.runs; i++) {
    let ms
    try {
      ms = timedRun(tarballPath)
    } catch (err) {
      process.stderr.write(
        `measure-cold-start: run ${i + 1}/${args.runs} failed: ${err.message ?? err}\n`,
      )
      process.exit(1)
    }
    runs_ms.push(Math.round(ms))
    process.stderr.write(`run ${i + 1}/${args.runs}: ${Math.round(ms)}ms\n`)
  }

  const result = buildResult({
    runs_ms,
    budget_ms: args.budget_ms,
    tarball: args.tarball ?? tarballPath,
  })

  process.stdout.write(`${JSON.stringify(result)}\n`)

  if (!result.ok) {
    process.stderr.write(
      `\nCOLD_START_BUDGET_EXCEEDED: median=${result.median_ms}ms threshold=${result.budget_ms}ms\n`,
    )
    process.stderr.write(`raw timings (ms): ${JSON.stringify(runs_ms)}\n`)
    process.stderr.write(`tarball: ${tarballPath}\n`)
    process.stderr.write(
      'hint: rebuild with `npm run build` and re-run, or audit dist/ size with `node scripts/verify-pack.mjs`\n',
    )
    process.exit(1)
  }

  process.exit(0)
}

// Run as CLI when invoked directly; library when imported.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`measure-cold-start: ${err.message ?? err}\n`)
    process.exit(1)
  })
}
