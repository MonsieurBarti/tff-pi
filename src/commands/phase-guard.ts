import type Database from "better-sqlite3";
import { getActiveMilestone, getProject, getSlice } from "../common/db.js";
import type { Phase, ValidateResult } from "../common/types.js";
import { predecessorPhase, verifyPhaseArtifacts } from "../orchestrator.js";

/**
 * Blocks entry into `targetPhase` when the predecessor phase did not produce
 * its required artifacts. Mirrors GSD-2's pattern of deriving readiness from
 * on-disk/DB state rather than trusting optimistically-set slice.status.
 *
 * `projectRoot` may be null in tests that don't set up artifacts — in that
 * case the guard is a no-op (tests that want to assert blocking should pass
 * a real root).
 */
export function assertPhasePreconditions(
	db: Database.Database,
	projectRoot: string | null,
	sliceId: string,
	targetPhase: Phase,
): ValidateResult {
	if (!projectRoot) return { valid: true };
	const slice = getSlice(db, sliceId);
	if (!slice) return { valid: true };

	const predecessor = predecessorPhase(targetPhase, slice.tier);
	if (!predecessor) return { valid: true };

	const project = getProject(db);
	if (!project) return { valid: true };
	const milestone = getActiveMilestone(db, project.id);
	if (!milestone) return { valid: true };

	const result = verifyPhaseArtifacts(db, projectRoot, slice, milestone.number, predecessor);
	if (!result.ok) {
		return {
			valid: false,
			error: `Cannot start ${targetPhase}: previous phase '${predecessor}' is incomplete — missing ${result.missing.join(", ")}. Re-run ${predecessor}.`,
		};
	}
	return { valid: true };
}
