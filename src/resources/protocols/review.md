# Review Protocol

The review phase runs as a single subagent dispatch. You do NOT author `phase_complete`; the dispatcher's `tool_result` hook runs the review finalizer, which ingests REVIEW.md, parses your VERDICT line, and emits `phase_complete` (approved) or `phase_failed` (denied, missing artifact, or malformed verdict).

## Input (provided as labeled artifact blocks)
- SPEC.md (ACs), PLAN.md, VERIFICATION.md, security-lens reference
- Diff: inspect yourself in `<cwd>` using `git diff <milestoneBranch>...<sliceBranch>`. Use `--stat` first, then scope by file.

## Steps
1. Code review lens: read SPEC.md + PLAN.md; for each changed file, decide Critical / Important / Suggestion per finding, citing `file:line`.
2. Security review lens: same diff, audit per security-lens guidance (injection, auth/authz, secrets, crypto, input validation). Cite `file:line` + severity.
3. Decide VERDICT: `approved` if no Critical findings; `denied` otherwise.
4. Write `<cwd>/.pi/.tff/artifacts/REVIEW.md` — combined code + security findings, tasks to rework (if denied), and a trailing line: `VERDICT: approved` or `VERDICT: denied`.
5. End with `STATUS: <...>` and `EVIDENCE: <...>`.

## Output contract
- REVIEW.md MUST contain exactly one line matching `^VERDICT: (approved|denied)$`.
- The VERDICT line MUST be uncompressed — exact wording, lowercase verdict value, no R1-R10 substitutions — even when `compress.user_artifacts` is enabled. Only this line is exempt from compression; the rest of REVIEW.md follows the artifact compression setting.
- If VERDICT is missing or malformed, the finalizer stamps phase_failed — the phase does NOT complete.
- `denied` routes the slice back to execute with tasks reset to open.
