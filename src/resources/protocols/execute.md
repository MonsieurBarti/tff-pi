# Execute Protocol

<HARD-GATE>
The execute phase runs against a GIT WORKTREE, not the project root.
The slice's WORKTREE path is given in the message. ALL file writes,
edits, and git commands MUST target that path:

- Bash tool: `cd <worktree>` first, or pass `cwd` to each call
- Write/Edit tool: use absolute paths under the worktree
- Never touch files outside the worktree (including the TFF repo itself)

If you write to the project root, the verify phase sees an empty
worktree diff and the work is effectively lost.
</HARD-GATE>

## Input
- Task record (title, description, files, wave)
- SPEC.md ACs mapped to this task
- PLAN.md context
- Previous wave outputs (wave>1)

## Steps
1. Read task scope — files, ACs, prior wave deps
2. TDD cycle per behavior:
   - Write failing test → run → confirm red
   - Implement minimal → run → confirm green
   - Commit: `feat(<slice>): T<nn> — <desc>`
3. Repeat until task scope covered
4. Multiple commits expected (1 per TDD cycle)

## Rules
- Only modify files in task scope
- No changes to .tff/ directory
- All tests must pass before done
