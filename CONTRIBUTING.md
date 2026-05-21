# Contributing

First — thank you for the interest. A quick note on how this project is run, so we don't waste each other's time.

## External pull requests aren't accepted right now

This repository is maintained by [@ChuckMayo](https://github.com/ChuckMayo). At this stage of the project, **pull requests from outside contributors are automatically closed** by a GitHub Action.

This is not a snub. The reasons are pragmatic:

- The CLI's surface is generated from Linear's GraphQL schema and a small set of curated commands. Most contribution-shaped changes are easier to coordinate as issues than as PRs.
- The output envelope is a public contract that agents pin against. Drift introduced through unreviewed PRs would silently break agent consumers.
- Solo-maintainer review bandwidth is the bottleneck, not code volume.

This policy may relax once the project is past 1.0.

## What you *can* do — and what helps most

- **Open an issue.** Bug reports, missing-operation requests, output-contract concerns, integration questions — all welcome. The more specific the reproduction, the better.
- **Fork it.** The repo is MIT-licensed. Fork freely and run your own variant. If your fork ships a useful pattern, mention it in an issue and we'll consider folding it in (we'll write the PR ourselves to keep the contract tight).
- **Test it against your agent runtime.** If you got it working in Codex CLI, Gemini CLI, Cursor, Copilot CLI, or anything else, file an issue with what worked and what didn't. That's gold.
- **Star the repo** if it's useful to you — that's how I know whether to keep investing.

## Filing a good issue

A perfect issue includes:

1. **What you ran** — the exact command line.
2. **What you saw** — the stdout + stderr (use a fenced ```` ``` ```` block).
3. **What you expected.**
4. **`node --version` and the CLI version** (`npx -y linear-agent --version`).
5. **Your agent runtime**, if relevant (Claude Code, Codex CLI, etc.).

Redact your `LINEAR_API_KEY` before pasting anything. The CLI itself never prints it; if you see one in output, please tell us — that's a bug we want to fix immediately.

## Security disclosures

If you find a security issue (token leak, injection sink, sandbox escape, anything that could harm a user's Linear data), **please don't open a public issue**. Open a [GitHub Security Advisory](https://github.com/ChuckMayo/linear-multi-workspace-cli/security/advisories/new) instead. We'll respond within a few days.

Thanks for reading.
