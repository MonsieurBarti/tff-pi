import type { PhaseModule } from "../common/phase.js";
import type { Phase } from "../orchestrator.js";
import { discussPhase } from "./discuss.js";
import { executePhase } from "./execute.js";
import { planPhase } from "./plan.js";
import { researchPhase } from "./research.js";

export const phaseModules: Partial<Record<Phase, PhaseModule>> = {
	discuss: discussPhase,
	research: researchPhase,
	plan: planPhase,
	execute: executePhase,
};
