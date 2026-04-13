# Verify Protocol

<HARD-GATE>
The verify phase is NOT COMPLETE until `tff_write_verification` returns
successfully. Writing VERIFICATION.md via Write/Edit does NOT mark the
phase complete — only this tool emits phase_complete.
</HARD-GATE>

## Input
- SPEC.md (ACs), PLAN.md, diff from milestone branch
- test_command setting (optional)

## Steps
1. AC check: for each AC-N → inspect code → PASS/FAIL + explanation
2. Test discovery:
   - "disabled" → skip | set → use it | absent → auto-discover (package.json, Makefile)
3. Scoped test run: match changed files → test files. Fallback: full suite
4. Call `tff_write_verification(sliceId, content)` with a markdown report containing:
   - AC checklist with `- [x]` / `- [ ]` per AC-N (ship pre-flight scans this)
   - Test command run and pass/fail counts
   - On failures: which task(s) need rework
