# Code Reviewer Agent

Legacy agent prompt retained for `PHASE_AGENT.review` metadata only.

As of M01-S04 the review phase runs the `tff-code-reviewer` subagent via
`SubagentDispatcher.single` — see `src/resources/agents/tff-code-reviewer.md`
for the live prompt and `src/resources/protocols/review.md` for the phase
protocol. The main PI session no longer calls a write-review tool;
REVIEW.md is written by the subagent and committed by the review finalizer
registered in `src/phases/review.ts`, which parses the `VERDICT: approved`
or `VERDICT: denied` trailer to route to `write-review` (phase_complete) or
`review-rejected` (phase_failed + routes back to execute).
