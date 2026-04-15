// Single chokepoint for the state_branch.enabled toggle. Every state-branch
// entry point gates on this. Audit new call sites with: grep -r "isStateBranchEnabled"
import { readArtifact } from "./artifacts.js";
import type { TffContext } from "./context.js";
import { DEFAULT_SETTINGS, parseSettings } from "./settings.js";

export function isStateBranchEnabled(ctx: TffContext): boolean {
	return (ctx.settings ?? DEFAULT_SETTINGS).state_branch.enabled;
}

export function isStateBranchEnabledForRoot(root: string): boolean {
	const yaml = readArtifact(root, "settings.yaml");
	return parseSettings(yaml ?? "").state_branch.enabled;
}

export function isAutoDetectRenameEnabled(root: string): boolean {
	const yaml = readArtifact(root, "settings.yaml");
	return parseSettings(yaml ?? "").state_branch.auto_detect_rename;
}
