import type Database from "better-sqlite3";
import { getEventLog } from "../common/db.js";
import { formatDuration } from "../common/format.js";

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
