# Review Protocol

## Input
- SPEC.md, PLAN.md, VERIFICATION.md (inlined)
- Diff: NOT inlined. Run `git diff <milestoneBranch>...<sliceBranch>` yourself in the worktree. The phase message gives you the exact commands.
- Review type: "code" or "security"

## Recommended workflow
1. `git diff --stat` to see file footprint
2. Read SPEC/PLAN/VERIFICATION to form a review lens
3. Diff files in priority order (largest/riskiest first); use `-- <path>` to scope
4. Record findings with file:line references

## Verdict
Return JSON: `{ verdict: "approved"|"denied", summary, findings: [{file,line,severity,message}], tasksToRework: ["T01"] }`

## Rules
- approved=no blocking issues | denied=changes required
- findings: specific files+lines, not vague
- tasksToRework: which PLAN tasks need re-execution
