import type Database from "better-sqlite3";
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
