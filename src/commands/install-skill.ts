/**
 * `linear-agent install-skill` — Phase 5 PLAN 05-02 Task 3, DST-06.
 *
 * Top-level command. Copies the bundled SKILL.md into
 * `~/.claude/skills/linear-agent/SKILL.md`. No flags in v1; deterministic
 * overwrite is the contract.
 *
 * Two-export pattern (S1): default oclif `Command` class + named
 * `runInstallSkill` wrapper. Tests target the named export; oclif discovers
 * the default class through the manifest.
 *
 * Workspace-less: this command makes ZERO network calls and does not call
 * `resolveWorkspace`. Mirrors `list-tools` exactly.
 */
import { Command } from '@oclif/core'
import { installSkillRuntime } from '@/lib/install-skill-runtime.js'
import { BASE_FLAGS, type CommandOutput, runCommand } from '@/lib/workspace-runtime.js'

export interface RunInstallSkillArgs {
  pretty: boolean
  /** MNT-02: omit meta from success envelope. Failure envelope unchanged. */
  noMeta?: boolean
  /** MNT-02: imply --no-meta AND mute pretty-mode banner. */
  quiet?: boolean
  /** MNT-03: extra retry attempts on transient errors. Default 0. No-op for this no-network command. */
  retry?: number
}

export async function runInstallSkill(args: RunInstallSkillArgs): Promise<CommandOutput> {
  const runArgs: Parameters<typeof runCommand>[0] = {
    commandPath: 'install-skill',
    pretty: args.pretty,
    handler: async (_retryOpts) => {
      const result = await installSkillRuntime({ env: process.env })
      // meta.command is injected by runCommand — return only the non-command meta fields
      return { data: result.data, meta: result.meta }
    },
  }
  if (args.noMeta !== undefined) runArgs.noMeta = args.noMeta
  if (args.quiet !== undefined) runArgs.quiet = args.quiet
  if (args.retry !== undefined) runArgs.retry = args.retry
  return runCommand(runArgs)
}

export default class InstallSkill extends Command {
  static override description =
    'Copy the bundled Claude Code skill to ~/.claude/skills/linear-agent/SKILL.md.'
  static override enableJsonFlag = true
  static override flags = { ...BASE_FLAGS }
  // NO workspace flag — install-skill makes zero network calls

  async run(): Promise<unknown> {
    const { flags } = await this.parse(InstallSkill)
    const callArgs: RunInstallSkillArgs = { pretty: flags.pretty }
    if (flags.quiet !== undefined) callArgs.quiet = flags.quiet
    if (flags.noMeta !== undefined) callArgs.noMeta = flags.noMeta
    if (flags.retry !== undefined) callArgs.retry = flags.retry
    const out = await runInstallSkill(callArgs)
    process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    if (out.exitCode !== 0) this.exit(out.exitCode)
    // In --pretty mode, stdout is human-readable text (not JSON). Parsing it
    // would throw SyntaxError and surface as an oclif uncaught-exception
    // traceback — confusing both humans and agent error-branching. Only
    // parse when we know stdout is the JSON envelope.
    return flags.pretty ? undefined : JSON.parse(out.stdout)
  }
}
