import type { TffContext } from "../common/context.js";
import type { PhaseContext, PhaseModule } from "../common/phase.js";
import { runPhaseWithFreshContext } from "../common/phase.js";
import type { Phase } from "../common/types.js";

/**
 * Shared wrapper around `runPhaseWithFreshContext` for slash commands that
 * run a heavy phase (discuss, research, plan, execute, verify). Surfaces
 * failure via ctx.ui / sendUserMessage; success is silent (the agent takes
 * over in the fresh session).
 */
export async function runHeavyPhase(
	ctx: TffContext,
	phase: Phase,
	mod: PhaseModule,
	phaseCtx: PhaseContext,
): Promise<void> {
	const result = await runPhaseWithFreshContext({
		phaseModule: mod,
		phaseCtx,
		cmdCtx: ctx.cmdCtx,
		phase,
	});
	if (!result.success && result.error) {
		if (ctx.cmdCtx?.hasUI) {
			ctx.cmdCtx.ui.notify(`Phase ${phase} failed: ${result.error}`, "error");
		} else {
			phaseCtx.pi.sendUserMessage(`Phase ${phase} failed: ${result.error}`);
		}
	}
}
