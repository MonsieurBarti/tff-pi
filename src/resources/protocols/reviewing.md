# Review Protocol

## Input
- SPEC.md, PLAN.md, VERIFICATION.md, diff from milestone branch
- Review type: "code" or "security"

## Verdict
Return JSON: `{ verdict: "approved"|"denied", summary, findings: [{file,line,severity,message}], tasksToRework: ["T01"] }`

## Rules
- approved=no blocking issues | denied=changes required
- findings: specific files+lines, not vague
- tasksToRework: which PLAN tasks need re-execution
