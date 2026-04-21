# Execute Protocol

The execute phase dispatches one subagent per task, one wave at a time, via `SubagentDispatcher.parallel`. Each subagent sees only its own task. You do NOT author `tff_checkpoint` or `tff_execute_done` — the dispatcher's `tool_result` finalizer closes tasks, checkpoints each wave, and emits `phase_complete` after the final wave.

## Per-task contract
1. Work exclusively under `<cwd>` (the slice worktree).
2. TDD per behavior: failing test → minimal impl → commit.
3. Only modify files in your task's scope. Other executors touch other files in parallel.
4. Commit message: `feat(<slice>): T<nn> — <desc>`.
5. End your final response with:
   `STATUS: <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>`
   `EVIDENCE: <one-line summary>`

## Failure modes
- `BLOCKED` / `NEEDS_CONTEXT` — the wave fails; user re-runs `/tff execute` and only your task re-dispatches.
- `index.lock` contention — retry once; surface `BLOCKED` if still locked.
- Scope creep — surface `BLOCKED`; the task description is the only authoritative scope.
