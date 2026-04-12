import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import type { TffContext } from "../common/context.js";
import { getEventLog, getMilestones, getProject, getSlices } from "../common/db.js";
import { formatDuration } from "../common/format.js";
import type { Slice } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";

export function handleLogs(
	db: Database.Database,
	sliceId: string,
	options?: { json?: boolean },
): string {
	const events = getEventLog(db, sliceId);
	if (events.length === 0) return "No events recorded for this slice.";

	if (options?.json) {
		return events.map((e) => e.payload).join("\n");
	}

	const lines: string[] = [];
	for (const entry of events) {
		const payload = JSON.parse(entry.payload) as Record<string, unknown>;
		const ts = payload.timestamp as string;
		const time = ts ? ts.substring(11, 19) : "??:??:??";
		const extra: string[] = [];
		if (payload.phase) extra.push(String(payload.phase));
		if (payload.durationMs) extra.push(formatDuration(payload.durationMs as number));
		if (payload.wave)
			extra.push(`wave=${payload.wave}${payload.totalWaves ? `/${payload.totalWaves}` : ""}`);
		if (payload.taskCount) extra.push(`tasks=${payload.taskCount}`);
		if (payload.tier) extra.push(`tier=${payload.tier}`);
		if (payload.verdict) extra.push(`${payload.verdict}`);
		if (payload.error) extra.push(String(payload.error).substring(0, 60));

		lines.push(`${time}  ${entry.type.padEnd(18)}${extra.join("  ")}`);
	}
	return lines.join("\n");
}

function findSliceByLabel(db: Database.Database, label: string): Slice | null {
	const match = label.match(/^M(\d+)-S(\d+)$/i);
	if (!match || !match[1] || !match[2]) return null;
	const mNum = Number.parseInt(match[1], 10);
	const sNum = Number.parseInt(match[2], 10);
	const project = getProject(db);
	if (!project) return null;
	const milestones = getMilestones(db, project.id);
	const milestone = milestones.find((m) => m.number === mNum);
	if (!milestone) return null;
	const slices = getSlices(db, milestone.id);
	return slices.find((s) => s.number === sNum) ?? null;
}

export async function runLogs(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	if (!ctx.db) {
		throw new Error("TFF database not initialized. Run `/tff new` to set up the project.");
	}
	const db = ctx.db;
	const rawArgs = args.join(" ").trim();
	const jsonFlag = rawArgs.includes("--json");
	const label = rawArgs.replace("--json", "").trim();
	const slice = label ? findSliceByLabel(db, label) : null;
	const activeSlice = findActiveSlice(db);
	const targetSlice = slice ?? activeSlice;
	if (!targetSlice) {
		pi.sendUserMessage("No slice found. Usage: `/tff logs [M01-S01] [--json]`");
		return;
	}
	const result = handleLogs(db, targetSlice.id, { json: jsonFlag });
	pi.sendUserMessage(result);
}
