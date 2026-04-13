import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { getMilestones, getProject, getSlices } from "../common/db.js";

export function handleHealth(db: Database.Database): string {
	const project = getProject(db);
	if (!project) {
		return "TFF health: database connected, no project found. Run `/tff new` to create one.";
	}

	const milestones = getMilestones(db, project.id);
	let sliceCount = 0;
	for (const m of milestones) {
		sliceCount += getSlices(db, m.id).length;
	}

	return `TFF health: OK\n- Project: ${project.name}\n- Milestones: ${milestones.length}\n- Slices: ${sliceCount}\n- DB: connected`;
}

export async function runHealth(
	pi: ExtensionAPI,
	ctx: TffContext,
	uiCtx: ExtensionCommandContext | null,
	_args: string[],
): Promise<void> {
	let msg: string;
	try {
		msg = handleHealth(getDb(ctx));
	} catch (err) {
		msg = `TFF health: NOT OK — ${err instanceof Error ? err.message : String(err)}`;
	}
	if (ctx.initError) {
		msg += `\n- Init warning: ${ctx.initError}`;
	}
	if (uiCtx?.hasUI) {
		uiCtx.ui.notify(msg, "info");
	}
	pi.sendUserMessage(msg);
}
