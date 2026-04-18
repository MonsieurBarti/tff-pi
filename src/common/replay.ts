import type Database from "better-sqlite3";
import { hashEvent, loadCursor, readEvents, updateLogCursor } from "./event-log.js";
import { logError, logWarning } from "./logger.js";
import { validateCommandPreconditions } from "./preconditions.js";
import { UnknownCommandError, projectCommand } from "./projection.js";

export function tailReplay(db: Database.Database, root: string): void {
	const { lastHash, lastRow } = loadCursor(db);

	// Cursor integrity check
	if (lastRow > 0) {
		const eventsAtCursor = readEvents(root, lastRow - 1);
		const eventAtCursor = eventsAtCursor[0];
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

	// NOTE: readEvents skips malformed lines (parse failures). If malformed lines
	// appear before lastRow, the physical-line offset used by readEvents will
	// diverge from lastRow (which counts valid events). This can cause the last
	// projected event to be replayed on the next startup. Since override-status
	// and other projection handlers are idempotent or safe to replay, this is
	// accepted as a known limitation until event-log.ts tracks physical row numbers.
	const tail = readEvents(root, lastRow);
	if (tail.length === 0) return;

	for (let i = 0; i < tail.length; i++) {
		const event = tail[i] as (typeof tail)[number];
		const currentRow = lastRow + i + 1;

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
