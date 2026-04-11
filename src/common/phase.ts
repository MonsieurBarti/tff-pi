import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { Settings } from "./settings.js";
import type { Slice, SubAgentActivity } from "./types.js";

export interface PhaseContext {
	pi: ExtensionAPI;
	db: Database.Database;
	root: string;
	slice: Slice;
	milestoneNumber: number;
	settings: Settings;
	feedback?: string;
	headless?: boolean;
	onSubAgentActivity?: (activity: SubAgentActivity) => void;
}

export interface PhaseResult {
	success: boolean;
	retry: boolean;
	error?: string;
	feedback?: string;
}

export interface PhaseModule {
	run(ctx: PhaseContext): Promise<PhaseResult>;
}
