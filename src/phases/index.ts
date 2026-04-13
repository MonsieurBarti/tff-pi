import type { PhaseModule } from "../common/phase.js";
import type { Phase } from "../common/types.js";
import { discussPhase } from "./discuss.js";
import { executePhase } from "./execute.js";
import { planPhase } from "./plan.js";
import { researchPhase } from "./research.js";
import { reviewPhase } from "./review.js";
import { shipFixPhase } from "./ship-fix.js";
import { shipPhase } from "./ship.js";
import { verifyPhase } from "./verify.js";

export const phaseModules: Record<Phase, PhaseModule> = {
	discuss: discussPhase,
	research: researchPhase,
	plan: planPhase,
	execute: executePhase,
	verify: verifyPhase,
	review: reviewPhase,
	ship: shipPhase,
	"ship-fix": shipFixPhase,
};
