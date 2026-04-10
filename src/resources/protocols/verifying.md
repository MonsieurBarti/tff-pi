# Verify Protocol

## Input
- SPEC.md (ACs), PLAN.md, diff from milestone branch
- test_command setting (optional)

## Steps
1. AC check: for each AC-N → inspect code → PASS/FAIL + explanation
2. Test discovery:
   - "disabled" → skip | set → use it | absent → auto-discover (package.json, Makefile)
3. Scoped test run: match changed files → test files. Fallback: full suite
4. Return structured JSON: `{ acResults: [...], testResults: {...} }`
