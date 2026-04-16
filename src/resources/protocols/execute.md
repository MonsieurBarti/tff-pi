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
5. After every task in a wave is complete, call `tff_checkpoint` then
   IMMEDIATELY proceed to the next wave in the same session. Do NOT stop,
   summarize, or ask the user to continue between waves. The phase only
   ends when every wave's tasks are implemented and committed.
6. **After the final wave is checkpointed, call `tff_execute_done` exactly once** with the slice label. This is the ONLY signal that execute finished — without it, the user has no hint for what to run next. After `tff_execute_done` returns, STOP. Do not call `/tff verify` yourself.

## Rules
- Only modify files in task scope
- No changes to .tff/ directory
- All tests must pass before done

## Git Checkpoints

After completing all tasks in a wave, call the `tff_checkpoint` tool with the current slice label and `wave-{N}` as the checkpoint name (e.g., `wave-1`, `wave-2`). This creates a rollback point that crash recovery can use.
