import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import * as addRemote from "./add-remote.js";
import * as askUser from "./ask-user.js";
import * as checkpoint from "./checkpoint.js";
import * as classify from "./classify.js";
import * as completeMilestoneChanges from "./complete-milestone-changes.js";
import * as completeMilestoneMerged from "./complete-milestone-merged.js";
import * as createProject from "./create-project.js";
import * as createSlice from "./create-slice.js";
import * as executeDone from "./execute-done.js";
import * as queryState from "./query-state.js";
import * as shipApplyDone from "./ship-apply-done.js";
import * as shipChanges from "./ship-changes.js";
import * as shipFix from "./ship-fix.js";
import * as shipMerged from "./ship-merged.js";
import * as transition from "./transition.js";
import * as writePlan from "./write-plan.js";
import * as writePr from "./write-pr.js";
import * as writeRequirements from "./write-requirements.js";
import * as writeResearch from "./write-research.js";
import * as writeReview from "./write-review.js";
import * as writeSpec from "./write-spec.js";
import * as writeVerification from "./write-verification.js";

export const TOOL_REGISTRARS = [
	queryState.register,
	transition.register,
	classify.register,
	createProject.register,
	addRemote.register,
	createSlice.register,
	executeDone.register,
	writeSpec.register,
	writeRequirements.register,
	writeResearch.register,
	writePlan.register,
	askUser.register,
	writeVerification.register,
	writePr.register,
	writeReview.register,
	shipMerged.register,
	shipChanges.register,
	completeMilestoneMerged.register,
	completeMilestoneChanges.register,
	shipFix.register,
	shipApplyDone.register,
	checkpoint.register,
] as const;

export function registerAllTools(pi: ExtensionAPI, ctx: TffContext): void {
	for (const r of TOOL_REGISTRARS) r(pi, ctx);
}
