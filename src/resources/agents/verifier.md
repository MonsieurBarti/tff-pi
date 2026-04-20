# Verifier Agent

Legacy agent prompt retained for `PHASE_AGENT.verify` metadata only.

As of M01-S03 the verify phase runs the `tff-verifier` subagent via
`SubagentDispatcher.single` — see `src/resources/agents/tff-verifier.md` for
the live prompt and `src/resources/protocols/verify.md` for the phase
protocol. The main PI session no longer authors VERIFICATION.md / PR.md
directly; artifacts are written by the subagent and committed by the verify
finalizer registered in `src/phases/verify.ts`.
