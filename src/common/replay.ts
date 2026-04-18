import type Database from "better-sqlite3";
import {
	hashEvent,
	loadCursor,
	readEventAtPhysicalLine,
	readEventsWithPositions,
	updateLogCursor,
} from "./event-log.js";
import { logError, logWarning } from "./logger.js";
import { validateCommandPreconditions } from "./preconditions.js";
import { UnknownCommandError, projectCommand } from "./projection.js";

export function tailReplay(db: Database.Database, root: string): void {
	const { lastHash, lastRow } = loadCursor(db);

	// Cursor integrity check
	if (lastRow > 0) {
		const eventAtCursor = readEventAtPhysicalLine(root, lastRow - 1);
		if (!eventAtCursor) {
			logError("replay", "cursor-hash-mismatch", {
				row: String(lastRow),
				error: "event-log shorter than cursor row",
			});
		} else {
			const computed = hashEvent(eventAtCursor.cmd, eventAtCursor.params);
			if (computed !== lastHash) {
				logError("replay", "cursor-hash-mismatch", {
					row: String(lastRow),
					error: `stored=${lastHash} computed=${computed}`,
				});
			}
		}
	}

	// lastRow is a physical newline count (set by appendCommand via byte scan).
	// readEventsWithPositions carries the physical line index so that malformed
	// lines before lastRow do not shift currentRow and cause over-replay on next boot.
	const tail = readEventsWithPositions(root, lastRow);
	if (tail.length === 0) return;

	for (const { event, physicalLine } of tail) {
		const currentRow = physicalLine + 1;

		const inv = validateCommandPreconditions(db, root, event.cmd, event.params);
		if (!inv.ok) {
			logWarning("replay", "invariant-violation", {
				cmd: event.cmd,
				row: String(currentRow),
				...(inv.reason !== undefined && { error: inv.reason }),
			});
			updateLogCursor(db, event.hash, currentRow);
			continue;
		}

		try {
			db.transaction(() => {
				projectCommand(db, root, event.cmd, event.params);
				updateLogCursor(db, event.hash, currentRow);
			})();
		} catch (err) {
			if (err instanceof UnknownCommandError) {
				logWarning("replay", "unknown-command", { cmd: event.cmd, row: String(currentRow) });
			} else {
				logError("replay", "projection-failed", {
					cmd: event.cmd,
					row: String(currentRow),
					error: err instanceof Error ? err.message : String(err),
				});
			}
			updateLogCursor(db, event.hash, currentRow);
		}
	}
}
