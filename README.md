# linear-multi-workspace-cli

> A Linear CLI built for AI agents. Runtime-agnostic, multi-workspace, full GraphQL surface, JSON-by-default.

[![CI](https://github.com/ChuckMayo/linear-multi-workspace-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ChuckMayo/linear-multi-workspace-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

`linear-agent` is a single CLI that lets *any* AI coding agent — Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor, Copilot CLI — fully operate Linear. It exposes every operation Linear's GraphQL schema offers (~500), works across multiple Linear workspaces in the same agent session, and emits stable, versioned JSON envelopes that agents can parse without prompting.

```bash
npx -y linear-agent@latest workspace add --name acme --token lin_api_...
npx -y linear-agent@latest workspace add --name personal --token lin_api_...
npx -y linear-agent@latest issue list --workspace acme --team ENG --json
npx -y linear-agent@latest issue list --workspace personal --team SIDE --json
```

---

## Why this exists

Linear ships an official MCP server that's excellent — for Claude. If you're working in a different agent runtime, or if a single agent session needs to touch *more than one Linear workspace*, you hit walls fast:

| Capability                               | Official Linear plugin | `linear-agent` |
| ---------------------------------------- | ---------------------- | -------------- |
| Works in Claude Code                     | ✅                     | ✅             |
| Works in Codex CLI / Gemini CLI / Cursor | ❌ (Claude only)       | ✅             |
| Works in any agent that can shell out    | ❌                     | ✅             |
| Multiple Linear workspaces per session   | ❌                     | ✅             |
| Full GraphQL surface (~500 ops)          | ⚠️ subset              | ✅             |
| JSON-by-default output                   | n/a (MCP)              | ✅             |
| Token-saving `--no-meta` / `--quiet`     | n/a                    | ✅             |
| Self-describing (`describe <cmd> --json`)| n/a                    | ✅             |
| Distributed via `npx` (no install)       | ❌                     | ✅             |

If your agent can run a shell command, it can run `linear-agent`.

---

## Quickstart

### Requirements
- Node.js **22** or newer
- A Linear personal API key — generate one at [linear.app/settings/api](https://linear.app/settings/api)

### 1. Register a workspace

```bash
npx -y linear-agent@latest workspace add --name acme --token lin_api_...
```

Workspaces are stored under the platform-conventional config dir (`~/Library/Preferences/...` on macOS, `$XDG_CONFIG_HOME/...` on Linux, `%APPDATA%\...` on Windows). Tokens never leave your machine.

### 2. Probe auth

```bash
npx -y linear-agent@latest me --json
```

Returns the resolved viewer + organization. Use this as your "did auth work" probe.

### 3. Use it

```bash
# Curated commands
npx -y linear-agent@latest issue list --team ENG --json
npx -y linear-agent@latest issue create --team ENG --title "Fix the thing" --json
npx -y linear-agent@latest comment create --issue ENG-123 --body "Done." --json

# Or any of the ~500 raw GraphQL operations
npx -y linear-agent@latest describe IssueBatchCreate --json
npx -y linear-agent@latest raw IssueBatchCreate --vars '{"input":{...}}' --json

# Or an arbitrary GraphQL query
npx -y linear-agent@latest graphql --query 'query { viewer { id } }' --json
```

Every command supports `--workspace <name>` to switch workspaces inline — no `workspace use` required.

---

## The JSON envelope contract

Every command emits a versioned envelope. Pin tests against `data.*` paths, not human prose.

**Success:**
```json
{
  "$apiVersion": "1",
  "ok": true,
  "data": { /* command-specific payload */ },
  "meta": { "command": "issue list", "workspace": "acme" }
}
```

**Failure:**
```json
{
  "$apiVersion": "1",
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Title is required",
    "transient": false,
    "details": { "field": "title" }
  },
  "meta": { "command": "issue create" }
}
```

`ok: true` → exit 0. `ok: false` → exit > 0 (see error code taxonomy via `describe`). `error.transient: true` means a retry is appropriate.

Token-saving flags:
- `--no-meta` — drop the `meta` block from success envelopes (~150–250 bytes saved per call)
- `--quiet` — implies `--no-meta` + suppresses pretty banners
- `--retry N` — add N transient-error retries on top of the defaults

---

## Multiple Linear workspaces, one session

Register as many workspaces as you like:

```bash
npx -y linear-agent@latest workspace add --name work --token lin_api_...
npx -y linear-agent@latest workspace add --name oss  --token lin_api_...
npx -y linear-agent@latest workspace add --name side --token lin_api_...
npx -y linear-agent@latest workspace list --json
```

Then route any command at any workspace per-call:

```bash
npx -y linear-agent@latest issue list --workspace work --team ENG --json
npx -y linear-agent@latest issue list --workspace oss  --team CORE --json
```

Workspace resolution order: `--workspace <name>` flag → `LINEAR_WORKSPACE` env var → registry's active workspace → `LINEAR_API_KEY` env var (bypasses the registry entirely; useful in CI).

---

## Agent integrations

### Claude Code (bundled skill)

```bash
npx -y linear-agent@latest install-skill
```

Copies a Claude Code skill to `~/.claude/skills/linear-agent/SKILL.md`. The skill tells Claude when to invoke `linear-agent`, the envelope shape, and the self-discovery commands (`describe`, `list-tools`, `schema`).

### Codex CLI, Gemini CLI, Cursor, anything else

There's no plugin to install. Just point your agent at the binary:

```bash
# Codex CLI
codex exec "list my open Linear issues using 'linear-agent issue list --json'"

# Gemini CLI / Cursor / Copilot CLI / etc.
# Same pattern: shell out to `npx -y linear-agent@latest <cmd> --json`.
```

For best results, give your agent a one-page system prompt explaining:
1. Auth lives in `LINEAR_API_KEY` or `linear-agent workspace add`
2. Every command supports `--json` for machine output
3. `linear-agent list-tools --json` enumerates everything
4. `linear-agent describe <cmd> --json` returns the Zod-derived input/output schema for any command or raw operation

That's enough context for any modern coding agent to drive Linear correctly.

---

## Self-discovery

The CLI is introspectable so agents can learn the surface without external docs:

```bash
linear-agent list-tools --json          # every curated + raw command, one-line each
linear-agent describe issue create --json  # full Zod schema: required/optional flags, output shape, examples
linear-agent schema --json              # the entire vendored Linear GraphQL schema (introspection JSON)
```

`describe` is generated from the same Zod schemas that validate flags at runtime, so it's the canonical contract for what a command accepts and returns. Agents should prefer `describe` over reading source.

---

## Architecture

- **Language:** TypeScript, ESM-only, Node 22+
- **CLI framework:** [oclif](https://oclif.io/) (built-in `--json` mode, topic-based command organization)
- **API client:** [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk) (official, codegen'd from Linear's GraphQL schema)
- **Raw layer:** every operation in Linear's vendored schema is generated as a `TypedDocumentNode` and dispatched via the SDK's `rawRequest` escape hatch
- **Validation:** [Zod 4](https://zod.dev/) for flag parsing AND output schema generation (`describe` reuses the same schemas)
- **Bundling:** [tsdown](https://tsdown.dev/) for fast cold-start (<500 ms median target)
- **Config:** [`conf`](https://github.com/sindresorhus/conf) for the per-workspace registry (platform-conventional paths)

The CLI never stores anything beyond the workspace registry (names + API tokens) and a single active-workspace pointer. No telemetry, no analytics, no network calls outside the Linear API.

---

## Development

```bash
git clone https://github.com/ChuckMayo/linear-multi-workspace-cli.git
cd linear-multi-workspace-cli
npm install
cp .env.example .env  # add your LINEAR_API_KEY for smoke tests
npm run build
npm test
```

Useful scripts:
- `npm run lint` — Biome lint + format check
- `npm run typecheck` — `tsc --noEmit`
- `npm run codegen` — re-vendor the Linear schema + regenerate the raw operation registry
- `npm run smoke:phase-2` — end-to-end smoke against a real workspace (requires `.env`)

The vendored Linear schema lives at `schema.graphql`. A weekly GitHub Action (`schema-diff.yml`) detects drift against the live Linear API and opens a sync PR automatically for additive changes.

---

## Project status

Pre-1.0. The curated command surface, raw-layer dispatch, JSON envelope contract, multi-workspace registry, and the Claude Code skill bundle are all in place. Not yet published to npm under this name — the `npx` examples above are forward-looking and assume the package is published.

If you're evaluating this for production use, clone the repo and `npm link` for now.

---

## Contributing

This repository is **maintained by [@ChuckMayo](https://github.com/ChuckMayo)**. External pull requests are not accepted at this stage of the project — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the rationale and the right way to contribute (issues, discussions, forks).

---

## License

MIT — see [LICENSE](./LICENSE).
