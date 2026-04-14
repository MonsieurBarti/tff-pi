import YAML from "yaml";
import { readArtifact } from "./artifacts.js";
import type { TffContext } from "./context.js";

export interface Settings {
	model_profile: "quality" | "balanced" | "budget";
	compress: {
		user_artifacts: boolean;
		apply_to?: ("artifacts" | "context_injection" | "phase_prompts")[];
	};
	ship: {
		merge_method: "squash" | "rebase" | "merge";
	};
	test_command?: string;
	milestone_target_branch?: string;
	verify_commands?: { name: string; command: string }[];
	verify_auto_detect?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	model_profile: "balanced",
	compress: {
		user_artifacts: false,
	},
	ship: {
		merge_method: "squash",
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

		const validScopes = ["artifacts", "context_injection", "phase_prompts"] as const;
		type Scope = (typeof validScopes)[number];

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
				merge_method:
					parsed.ship?.merge_method === "rebase" || parsed.ship?.merge_method === "merge"
						? parsed.ship.merge_method
						: DEFAULT_SETTINGS.ship.merge_method,
			},
		};

		// Handle compress.apply_to: explicit array wins, legacy user_artifacts=true maps to ["artifacts"]
		if (Array.isArray(parsed.compress?.apply_to)) {
			settings.compress.apply_to = parsed.compress.apply_to.filter(
				(s: unknown): s is Scope =>
					typeof s === "string" && (validScopes as readonly string[]).includes(s),
			);
		} else if (settings.compress.user_artifacts === true) {
			settings.compress.apply_to = ["artifacts"];
		}

		if (typeof parsed.test_command === "string") {
			settings.test_command = parsed.test_command;
		}
		if (typeof parsed.milestone_target_branch === "string") {
			settings.milestone_target_branch = parsed.milestone_target_branch;
		}
		if (Array.isArray(parsed.verify_commands)) {
			settings.verify_commands = parsed.verify_commands.filter(
				(v: unknown) =>
					typeof v === "object" &&
					v !== null &&
					typeof (v as { name?: unknown }).name === "string" &&
					typeof (v as { command?: unknown }).command === "string",
			) as { name: string; command: string }[];
		}
		if (typeof parsed.verify_auto_detect === "boolean") {
			settings.verify_auto_detect = parsed.verify_auto_detect;
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

export function loadSettings(ctx: TffContext, root: string): void {
	const yaml = readArtifact(root, "settings.yaml");
	ctx.settings = yaml
		? parseSettings(yaml)
		: { ...DEFAULT_SETTINGS, compress: { ...DEFAULT_SETTINGS.compress } };
}
