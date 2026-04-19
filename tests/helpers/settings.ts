import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings, serializeSettings } from "../../src/common/settings.js";

/**
 * Writes a .tff/settings.yaml at <root> with state_branch.enabled=true.
 * Call in test setup when exercising state-branch code paths that require
 * the toggle on (post-M10-S5 default is off).
 */
export function seedEnabledSettings(
	root: string,
	overrides?: Partial<Settings["state_branch"]>,
): void {
	const s: Settings = {
		...DEFAULT_SETTINGS,
		state_branch: {
			enabled: true,
			auto_detect_rename: true,
			...overrides,
		},
	};
	mkdirSync(join(root, ".pi", ".tff"), { recursive: true });
	writeFileSync(join(root, ".pi", ".tff", "settings.yaml"), serializeSettings(s), "utf-8");
}
