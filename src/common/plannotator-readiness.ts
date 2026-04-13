let everHandled = false;

/**
 * Tracks whether plannotator has ever responded with `status: "handled"`
 * during this PI session. If yes, plannotator is mounted and any later
 * `status: "unavailable"` is a transient race (remount, reload) — don't
 * auto-approve, wait for the user's eventual click.
 *
 * Plannotator does NOT emit a `plannotator:ready` event upstream
 * (verified against /private/tmp/plannotator/apps/pi-extension), so we
 * piggyback on the response status instead.
 */
export function markHandled(): void {
	everHandled = true;
}

export function wasEverHandled(): boolean {
	return everHandled;
}

export function resetForTest(): void {
	everHandled = false;
}

/**
 * The exact error string plannotator emits when its `session_start` handler
 * has not yet fired and `activeSessionContext` is still null. Coupled to
 * upstream copy at apps/pi-extension/plannotator-events.ts:196-221 — if
 * upstream changes the wording, update this constant accordingly. Tests
 * pin this so a divergence is surfaced before it ships.
 */
export const PLANNOTATOR_NOT_READY_ERROR = "Plannotator context is not ready yet.";
