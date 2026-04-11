# Execute Protocol

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

## Git Checkpoints

After completing all tasks in a wave, call the `tff_checkpoint` tool with the current slice label and `wave-{N}` as the checkpoint name (e.g., `wave-1`, `wave-2`). This creates a rollback point that crash recovery can use.
