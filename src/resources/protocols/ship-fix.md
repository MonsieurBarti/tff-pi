# Ship-Fix Protocol

Apply reviewer feedback inline with user approval. Lightweight alternative to
re-running the full TDD execute loop.

## Phase prompt (delivered to a fresh PI session)

The user has confirmed PR review feedback should be applied inline. Read
`REVIEW_FEEDBACK.md` (in the slice artifacts dir under `.tff`), identify the
smallest possible diff, apply it in the worktree, run all quality gates,
and ask the user via `tff_ask_user` to approve before pushing.

If any quality gate fails, fix the issue and re-run from the first gate.
Do NOT ask the user to approve a patch that does not pass all gates.
See the inline-fixer agent prompt for how to discover the project's
quality gate commands (settings → lefthook → CI → package.json →
Makefile → language defaults).

Upon the user's reply:
- "Apply (commit + push)" → commit + push, then call `tff_ship_apply_done`.
- "Reject (revert)" → restore the worktree, then call
  `tff_ship_apply_done({ rejected: true })`.
