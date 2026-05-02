import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the directory the config file lives in.
 *
 * Order:
 *   1. `$XDG_CONFIG_HOME/linear-agent`  if the env var is set and non-empty
 *   2. `~/.config/linear-agent`         otherwise
 *
 * Cross-platform note: this honors XDG on Linux/macOS (and on Windows when
 * a shell sets the env explicitly). Native Windows path defaults
 * (`%APPDATA%\linear-agent`) are out of scope for v1 — see PROJECT.md
 * runtime parity matrix; the file mode story doesn't apply on NTFS anyway.
 */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'linear-agent')
}

/** Full path to the JSON config file (`<configDir>/config.json`). */
export function configPath(): string {
  return join(configDir(), 'config.json')
}
