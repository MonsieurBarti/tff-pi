---
name: report-issue
description: "Use when the user wants to report a bug, file an issue, or send feedback about tff-pi (The Forge Flow PI extension). Triggers on phrases like 'report issue', 'file a bug', 'tff-pi broke', 'something is wrong with tff', 'open an issue', '/skill:report-issue'."
---

# Report Issue

## When to Use

User reports tff-pi bug ∨ unexpected behavior ∨ wants to file an issue against the tff-pi repo. Repo target: `MonsieurBarti/tff-pi`.

Note: users invoking this skill are running tff-pi *inside their own project*. Their cwd is their project, not tff-pi. Treat `git log` and source files in cwd as user-project context — usually not relevant to a tff-pi bug. Prefer tff-pi-specific signals (STATE.md, event log, installed version).

## HARD-GATE

¬ submit until user explicitly confirms issue body (filing publicly = irreversible). Show full draft → ask `submit? [y/N]`. Default = ¬ submit.

## Checklist

1. **Detect command** — verify `gh` available: `gh --version`. ¬ available → abort, instruct user `brew install gh && gh auth login`. Then `gh auth status` — ¬ authed → instruct `gh auth login`.
2. **Collect context** — gather in parallel:
   - tff-pi version: read installed `package.json` — try `node_modules/@the-forge-flow/tff-pi/package.json`.version; fallback ask user.
   - pi version: `node_modules/@mariozechner/pi-coding-agent/package.json`.version (tff-pi is a pi extension; pi version matters).
   - node + OS: `node --version`, `uname -s -r`.
   - Recent state: `.pi/.tff/STATE.md` if exists (truncate ≤ 80 lines, scrub absolute paths under `/Users/<name>` → `~`).
   - Recent tff events: tail of `.pi/.tff/events.jsonl` if exists (last 20 lines, scrub paths).
   - User-supplied: error message, repro steps, expected vs actual.
3. **Classify** — ask user one question: `kind ∈ { bug, feature-request, question, docs }`. Default `bug`.
4. **De-dup check** — `gh issue list --repo MonsieurBarti/tff-pi --search "<title-keywords>" --state all --limit 5`. If close match → show user, ask whether to comment on existing or file new.
5. **Draft** — render issue body per template below.
6. **Show draft** — present title + body to user verbatim.
7. **Confirm** — `submit? [y/N]`. ¬ y → save draft to `/tmp/tff-pi-issue-<timestamp>.md` ∧ abort.
8. **Submit** — `gh issue create --repo MonsieurBarti/tff-pi --title "<title>" --body-file <draft-path> --label <kind>`.
9. **Report** — print returned URL.

## Issue Template

```md
## Summary
<one-line>

## Environment
- tff-pi: <version>
- pi-coding-agent: <version>
- node: <version>
- OS: <uname>

## Repro
<steps>

## Expected
<what should happen>

## Actual
<what happened — include error verbatim ∈ ``` fence>

## Context
<details>
<summary>STATE.md (truncated)</summary>

<.pi/.tff/STATE.md excerpt — paths scrubbed>

</details>

<details>
<summary>Recent events</summary>

<tail of .pi/.tff/events.jsonl — paths scrubbed>

</details>
```

## Output Format

- On success: `https://github.com/MonsieurBarti/tff-pi/issues/<n>`
- On abort: path to saved draft `/tmp/tff-pi-issue-<ts>.md`
- On `gh` missing: install instructions, ¬ partial state

## Anti-Patterns

- Submitting without showing the user the rendered body first (irreversible publish)
- Pasting full STATE.md ∨ events.jsonl unredacted (may contain repo paths ∨ secrets — truncate ∧ scrub)
- Auto-classifying as `bug` when user said "feature" ∨ "question"
- Inventing repro steps the user didn't provide — ask, ¬ guess
- Filing against the wrong repo (always `MonsieurBarti/tff-pi`, ¬ user's project repo, ¬ `tff-cc`)
- Including the user's project source / git log as "context" — irrelevant to a tff-pi bug ∧ leaks user code
- Re-submitting on retry without de-dup (step 4 is mandatory)

## Rules

- Repo target hard-coded: `MonsieurBarti/tff-pi`
- ∀ submission: user confirmation required
- ∀ context blob > 80 lines: truncate ∧ note `<truncated>`
- ¬ include secrets (env vars, tokens, absolute paths under `/Users/<name>` → mask to `~`)
- ¬ submit if `gh auth status` fails — instruct `gh auth login` instead
- ¬ confuse with sibling repo `MonsieurBarti/The-Forge-Flow-CC` (that is `tff-cc`, the Claude Code variant)
