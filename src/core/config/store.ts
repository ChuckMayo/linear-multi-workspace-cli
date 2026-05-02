/**
 * ConfigStore — atomic, 0600-aware reader/writer for the workspace registry.
 *
 * Design rationale (PITFALLS § Pitfalls 3,4 + CONTEXT § Config Storage):
 *
 *   We do NOT use `conf@^14` for this file. `conf` is excellent for general
 *   user-config storage but does not enforce a strict 0600 mode on read,
 *   which is precisely the property we need for token-bearing files. Wrapping
 *   `conf` to add the mode check would split logic across two libraries; a
 *   ~80 LOC bespoke writer is simpler to audit and easier to keep correct.
 *
 *   The store enforces three contract guarantees:
 *     1. The file mode on disk is exactly 0600 after every write.
 *     2. Reading a file whose mode is broader than 0600 fails closed with
 *        `CONFIG_PERMISSIONS_TOO_BROAD` (exit 11) BEFORE returning data.
 *     3. Writes are atomic from a reader's perspective: a sibling temp file
 *        (created with mode 0600 + fsync'd) is `rename`d into place. Readers
 *        never see a partial file.
 *
 *   Cross-platform note: POSIX modes don't apply on NTFS, so the
 *   permission-check is a no-op on Windows. v1 documents this as a known
 *   limitation; multi-user Windows boxes are outside the v1 threat model.
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { LinearAgentError } from '../errors/index.js'
import { configPath } from './paths.js'
import { type Config, ConfigSchema } from './schema.js'

const REQUIRED_DIR_MODE = 0o700
const IS_WINDOWS = process.platform === 'win32'

export interface LoadOptions {
  path?: string
}

export interface SaveOptions {
  path?: string
}

/**
 * Read the config file. Returns the empty config (`{ active: null, workspaces: {} }`)
 * if the file is missing — the very first `workspace add` writes it.
 *
 * Throws:
 *   - `CONFIG_PERMISSIONS_TOO_BROAD` (exit 11) if the file mode is broader
 *     than 0600 on a POSIX platform. Recovery: `chmod 600 <path>`.
 *   - `VALIDATION_FAILED` (exit 12) on malformed JSON or schema mismatch.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const target = opts.path ?? configPath()

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(target)
  } catch (e) {
    if (isErrnoException(e) && e.code === 'ENOENT') {
      // CONFIG_NOT_FOUND is treated as "empty config" per CONTEXT.md.
      // We never throw here — the agent should be able to start clean
      // and have `workspace add` create the file.
      return cloneEmpty()
    }
    throw LinearAgentError.generic(
      `failed to stat config file: ${(e as Error)?.message ?? String(e)}`,
    )
  }

  if (!IS_WINDOWS) {
    const fileMode = stat.mode & 0o777
    if (fileMode !== 0o600) {
      throw LinearAgentError.auth.configPermissionsTooBroad(target, octal(fileMode))
    }
  }

  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch (e) {
    throw LinearAgentError.generic(
      `failed to read config file: ${(e as Error)?.message ?? String(e)}`,
    )
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (e) {
    // Intentionally do NOT include `raw` in details — the file may contain
    // tokens. The redactor scrubs `lin_api_*` patterns from envelopes as a
    // second line of defense, but minimizing exposure is the right default.
    throw LinearAgentError.validation.failed('config file is not valid JSON', {
      stage: 'json-parse',
      path: target,
      parseError: (e as Error)?.message ?? String(e),
    })
  }

  const result = ConfigSchema.safeParse(parsedJson)
  if (!result.success) {
    // Zod issues do not include input values by default — they reference
    // paths and codes, not the data itself. Safe to surface in `details`.
    throw LinearAgentError.validation.failed('config file failed schema validation', {
      stage: 'schema',
      path: target,
      issues: result.error.issues,
    })
  }
  return result.data
}

/**
 * Write the config to disk atomically with mode 0600.
 *
 * The write protocol:
 *   1. Ensure parent directory exists with mode 0700 (recursive).
 *   2. Open a sibling temp file with `O_CREAT | O_WRONLY` and mode 0600.
 *   3. Write the serialized config + newline; `fsync`; `close`.
 *   4. `chmod 0600` defensively (umask may have masked the open() mode).
 *   5. `rename` the temp file over the target — atomic on POSIX.
 *   6. On any error mid-flight, attempt to unlink the temp file.
 */
export function saveConfig(config: Config, opts: SaveOptions = {}): void {
  // Validate-on-write so we never persist a bad shape. Mirrors the read-side gate.
  const validated = ConfigSchema.parse(config)
  const target = opts.path ?? configPath()
  const parent = dirname(target)

  try {
    mkdirSync(parent, { recursive: true, mode: REQUIRED_DIR_MODE })
  } catch (e) {
    throw LinearAgentError.generic(
      `failed to create config directory: ${(e as Error)?.message ?? String(e)}`,
    )
  }

  const tempPath = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  let fd: number | undefined
  try {
    fd = openSync(tempPath, 'wx', 0o600)
    const payload = `${JSON.stringify(validated, null, 2)}\n`
    writeSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    // Defense in depth — `openSync(...mode...)` is masked by `umask`. Force
    // 0600 explicitly. No-op on platforms that ignore POSIX modes.
    if (!IS_WINDOWS) chmodSync(tempPath, 0o600)

    renameSync(tempPath, target)
  } catch (e) {
    // Best-effort cleanup of any partial write.
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore — temp may not exist if openSync itself failed
    }
    if (e instanceof LinearAgentError) throw e
    throw LinearAgentError.generic(
      `failed to write config file: ${(e as Error)?.message ?? String(e)}`,
    )
  }
}

/**
 * Convenience: load → mutate → save in one call. Used by
 * `workspace add/use/remove/replace-token` in PLAN-04.
 *
 * Returns the saved config (post-mutator) so callers can inspect the result
 * without an extra `loadConfig` round-trip.
 */
export function updateConfig(mutator: (current: Config) => Config, opts: SaveOptions = {}): Config {
  const current = loadConfig({ path: opts.path })
  const next = mutator(current)
  saveConfig(next, opts)
  return next
}

function cloneEmpty(): Config {
  return { active: null, workspaces: {} }
}

function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string'
}
