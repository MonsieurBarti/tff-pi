import YAML from "yaml";

export interface Settings {
	model_profile: "quality" | "balanced" | "budget";
	compress: {
		user_artifacts: boolean;
	};
	ship: {
		auto_merge: boolean;
	};
	test_command?: string;
	milestone_target_branch?: string;
}

export const DEFAULT_SETTINGS: Settings = {
	model_profile: "balanced",
	compress: {
		user_artifacts: false,
	},
	ship: {
		auto_merge: false,
	},
};

export function parseSettings(yamlString: string): Settings {
	try {
		if (!yamlString || !yamlString.trim()) {
			return {
				...DEFAULT_SETTINGS,
				compress: { ...DEFAULT_SETTINGS.compress },
				ship: { ...DEFAULT_SETTINGS.ship },
			};
		}
		const parsed = YAML.parse(yamlString);
		if (!parsed || typeof parsed !== "object") {
			return {
				...DEFAULT_SETTINGS,
				compress: { ...DEFAULT_SETTINGS.compress },
				ship: { ...DEFAULT_SETTINGS.ship },
			};
		}
		const settings: Settings = {
			model_profile:
				parsed.model_profile === "quality" ||
				parsed.model_profile === "balanced" ||
				parsed.model_profile === "budget"
					? parsed.model_profile
					: DEFAULT_SETTINGS.model_profile,
			compress: {
				user_artifacts:
					typeof parsed.compress?.user_artifacts === "boolean"
						? parsed.compress.user_artifacts
						: DEFAULT_SETTINGS.compress.user_artifacts,
			},
			ship: {
				auto_merge:
					typeof parsed.ship?.auto_merge === "boolean"
						? parsed.ship.auto_merge
						: DEFAULT_SETTINGS.ship.auto_merge,
			},
		};
		if (typeof parsed.test_command === "string") {
			settings.test_command = parsed.test_command;
		}
		if (typeof parsed.milestone_target_branch === "string") {
			settings.milestone_target_branch = parsed.milestone_target_branch;
		}
		return settings;
	} catch {
		return {
			...DEFAULT_SETTINGS,
			compress: { ...DEFAULT_SETTINGS.compress },
			ship: { ...DEFAULT_SETTINGS.ship },
		};
	}
}

export function serializeSettings(settings: Settings): string {
	return YAML.stringify(settings);
}
