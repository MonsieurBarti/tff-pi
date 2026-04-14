import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TffContext } from "../common/context.js";
import { DEFAULT_SETTINGS } from "../common/settings.js";

export async function runSettings(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	const current = ctx.settings ?? DEFAULT_SETTINGS;
	pi.sendUserMessage(
		`Current TFF settings:\n\n- model_profile: ${current.model_profile}\n- compress.user_artifacts: ${current.compress.user_artifacts}\n- ship.merge_method: ${current.ship.merge_method}\n\nTo change settings, edit \`.tff/settings.yaml\` in your project root.`,
	);
}
