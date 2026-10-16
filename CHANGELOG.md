# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## Unreleased

### Fixed
- Read commands returned `null` for every related field (`state.name`, `assignee.email`,
  `team.key` on issues; `lead.email` on projects; `team.key` on labels and states). The
  SDK exposes relations as prototype getters, and hydration walked only own properties.
  All runtimes now share one `hydrateRelations` helper that reads them by property access.
- Date fields (`updatedAt`, `createdAt`, ...) printed as `{}`. They now print as ISO strings.
- The team `cycleEnabled` field never matched Linear's schema and was always `null`. It is
  now `cyclesEnabled`.

## 0.1.0 — 2026-06-24

First public release on npm, renamed from `linear-agent` to **`linmux`**. Alpha,
solo-maintained.

### Added
- Published to npm as `linmux` — `npx -y linmux@0.1.0 <command>` now works from a
  cold environment (previously the package was unpublished and `npx` 404'd).

### Changed
- **Renamed** the package, binary, and bundled Claude Code skill from `linear-agent`
  to `linmux`. The skill installs to `~/.claude/skills/linmux/SKILL.md`.
- Repositioned around the real wedge vs Linear's official MCP: multiple workspaces in
  one session **plus** the full ~500-op GraphQL surface **plus** a stable versioned
  JSON contract — delivered as a shell-out CLI. "Works in any agent" is no longer the
  headline (the official MCP already works in any MCP client).
- README/skill corrected: `workspace add <name>` is a positional argument (the prior
  `--name` example was wrong), and the config-dir description now matches the
  implementation.

### Notes / known limitations
- The on-disk config directory remains `~/.config/linear-agent/` (the former name),
  retained so existing workspace registrations survive the rename without a migration.
  A clean migration to `~/.config/linmux/` is a planned follow-up.
- Personal API keys only — no OAuth.
- Carryover from v1.0: 40 curated commands, the `raw`/`graphql` full-surface escape
  hatch (501 generated operations), `describe`/`list-tools`/`schema` introspection,
  and the `--no-meta`/`--quiet`/`--retry` token/retry knobs.
