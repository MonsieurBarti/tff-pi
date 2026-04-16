# Review Protocol

<HARD-GATE>
The review phase is NOT COMPLETE until `tff_write_review` returns
successfully. This is the only tool that emits phase_complete for review.
- verdict='approved' → unlocks ship
- verdict='denied'  → resets tasks to open, routes slice back to execute
</HARD-GATE>

## Input
- SPEC.md, PLAN.md, VERIFICATION.md (inlined)
- Diff: NOT inlined. Run `git diff <milestoneBranch>...<sliceBranch>` yourself in the worktree. The phase message gives you the exact commands.
- Review type: "code" or "security"

## Recommended workflow
1. `git diff --stat` to see file footprint
2. Read SPEC/PLAN/VERIFICATION to form a review lens
3. Diff files in priority order (largest/riskiest first); use `-- <path>` to scope
4. Record findings with file:line references

## Output
Call `tff_write_review(sliceId, content, verdict)`:
- content = markdown with: Summary, Findings table (file, line, severity, message), Tasks to rework
- verdict = "approved" | "denied"

## Rules
- approved=no blocking issues | denied=changes required
- findings: specific files+lines, not vague
- tasksToRework: which PLAN tasks need re-execution

## Phase end

When `tff_write_review` returns successfully (verdict=approved), the review phase is complete. STOP. Do not call any further tools. The user will advance to ship when ready. (If verdict=denied, the tool itself routes back to execute — stop, then the user re-runs execute.)
