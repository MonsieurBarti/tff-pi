import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type TffContext, getDb } from "../common/context.js";
import { findSliceByLabel } from "../common/db-resolvers.js";
import { getMilestone } from "../common/db.js";
import { formatDuration } from "../common/format.js";
import { readPerSliceLog } from "../common/per-slice-log.js";
import { sliceLabel } from "../common/types.js";
import { findActiveSlice } from "../orchestrator.js";

export function handleLogs(root: string, label: string, options?: { json?: boolean }): string {
	const lines = readPerSliceLog(root, label);
	if (lines.length === 0) return "No events recorded for this slice.";

	if (options?.json) {
		return lines.map((l) => JSON.stringify(l)).join("\n");
	}

	const out: string[] = [];
	for (const l of lines) {
		const ts = typeof l.ts === "string" ? l.ts : typeof l.timestamp === "string" ? l.timestamp : "";
		const time = ts ? ts.substring(11, 19) : "??:??:??";
		const type = typeof l.type === "string" ? l.type : String(l.ch ?? "");
		const extra: string[] = [];
		if (l.phase) extra.push(String(l.phase));
		if (l.durationMs) extra.push(formatDuration(l.durationMs as number));
		if (l.wave) extra.push(`wave=${l.wave}${l.totalWaves ? `/${l.totalWaves}` : ""}`);
		if (l.taskCount) extra.push(`tasks=${l.taskCount}`);
		if (l.tier) extra.push(`tier=${l.tier}`);
		if (l.verdict) extra.push(`${l.verdict}`);
		if (l.error) extra.push(String(l.error).substring(0, 60));

		out.push(`${time}  ${type.padEnd(18)}${extra.join("  ")}`);
	}
	return out.join("\n");
}

export async function runLogs(
	pi: ExtensionAPI,
	ctx: TffContext,
	_uiCtx: ExtensionCommandContext | null,
	args: string[],
): Promise<void> {
	const db = getDb(ctx);
	const root = ctx.projectRoot;
	if (!root) {
		pi.sendUserMessage("No project root found.");
		return;
	}
	const rawArgs = args.join(" ").trim();
	const jsonFlag = rawArgs.includes("--json");
	const labelArg = rawArgs.replace("--json", "").trim();
	const slice = labelArg ? findSliceByLabel(db, labelArg) : null;
	const activeSlice = findActiveSlice(db);
	const targetSlice = slice ?? activeSlice;
	if (!targetSlice) {
		pi.sendUserMessage("No slice found. Usage: `/tff logs [M01-S01] [--json]`");
		return;
	}
	const milestone = getMilestone(db, targetSlice.milestoneId);
	if (!milestone) {
		pi.sendUserMessage(`Milestone not found for slice ${targetSlice.id}`);
		return;
	}
	const label = sliceLabel(milestone.number, targetSlice.number);
	const result = handleLogs(root, label, { json: jsonFlag });
	pi.sendUserMessage(result);
}
