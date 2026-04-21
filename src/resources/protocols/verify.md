# Verify Protocol

The verify phase runs as a single subagent dispatch. You do NOT author `phase_complete`; the dispatcher's `tool_result` hook runs the verify finalizer, which ingests the artifacts you write and emits `phase_complete` on success.

## Input (provided as labeled artifact blocks)
- SPEC.md (ACs), PLAN.md, diff from milestone branch, mechanical verification report (if present), PR body template (if present)

## Steps
1. AC check: for each AC-N → inspect code → PASS/FAIL + evidence.
2. Test discovery: disabled → skip; set → use it; auto → discover.
3. Scoped test run (match changed files → test files; fallback full suite).
4. Write `<cwd>/.pi/.tff/artifacts/VERIFICATION.md`: AC checklist with `- [x]` / `- [ ]`, test command + counts, on fail the task(s) to rework.
5. Write `<cwd>/.pi/.tff/artifacts/PR.md`: concise reviewer-facing description (≤20 lines), uncompressed.
6. End with `STATUS: <...>` and `EVIDENCE: <...>`.

## Honesty
Every `bash` command you ran during this phase is captured from your message stream and audited against VERIFICATION.md claims by the finalizer. If a cited command's `isError` doesn't match the claim, the finalizer stamps `.audit-blocked` and emits `phase_failed` — the phase does NOT complete. Don't claim what you didn't run.
