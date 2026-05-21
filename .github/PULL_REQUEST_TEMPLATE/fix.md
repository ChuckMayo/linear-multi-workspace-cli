<!--
Use this template by appending ?template=fix.md to the New PR URL.
External PRs are auto-closed — see CONTRIBUTING.md.
-->

## Fix PR

Fixes #

### What was broken
<!-- The symptom, from the linked issue. -->

### Root cause
<!-- The actual underlying bug — not the symptom. If you can't name it, the fix probably isn't a fix yet. -->

### What the fix does
<!-- One paragraph. -->

### Verification
<!-- How you proved it's fixed (failing test now passes, repro no longer reproduces, etc.). -->

### Regression test
- [ ] Added — see `path/to/test.ts`
- [ ] Not added because: __________

### Verified on
- [ ] macOS
- [ ] Linux
- [ ] Windows (or N/A)

Runtimes:
- [ ] Claude Code
- [ ] OpenAI Codex CLI
- [ ] Gemini CLI
- [ ] Plain shell
- [ ] Other: __________

### Checklist
- [ ] No scope creep — only files necessary for the fix
- [ ] No `--no-verify` / no skipped hooks
- [ ] `.changeset/*.md` fragment added (or `no-changelog` label applied)
- [ ] Linked issue has `confirmed-bug` label

### Breaking changes
<!-- None, or list them with a migration note. -->
