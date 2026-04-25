import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type Database from "better-sqlite3";
import type { LogContext } from "../logger.js";
import { estimateAffectedFiles } from "../routing/affected-files.js";
import { decideAndAudit } from "../routing/decide-and-audit.js";
import { errnoCode } from "../routing/fs-helpers.js";
import { loadRoutingConfig } from "../routing/routing-config.js";
import { FilesystemSignalExtractor } from "../routing/signal-extractor.js";
import { milestoneLabel, sliceLabel } from "../types.js";

export interface RoutingDryRunOpts {
	root: string;
	db: Database.Database;
	log: (msg: string, ctx?: LogContext) => void;
}

export async function runRoutingDryRun(opts: RoutingDryRunOpts): Promise<void> {
	try {
		const config = await loadRoutingConfig(opts.root);
		if (!config.enabled) return;

		const open = findOpenSlice(opts.db);
		if (!open) return;

		const mLabel = milestoneLabel(open.milestoneNumber);
		const sLabel = sliceLabel(open.milestoneNumber, open.sliceNumber);
		const sliceDirPath = join(opts.root, ".pi", ".tff", "milestones", mLabel, "slices", sLabel);

		const planText = await readPlanIfPresent(join(sliceDirPath, "PLAN.md"));
		const affected = estimateAffectedFiles(planText);

		await decideAndAudit(
			{
				slice_id: open.sliceId,
				milestone_number: open.milestoneNumber,
				slice_number: open.sliceNumber,
				phase: "review",
				dry_run: true,
				extract_input: {
					slice_id: open.sliceId,
					spec_path: join(sliceDirPath, "SPEC.md"),
					plan_path: join(sliceDirPath, "PLAN.md"),
					affected_files: affected.files,
					description: open.title ?? "",
				},
			},
			{ root: opts.root, extractor: new FilesystemSignalExtractor() },
		);
	} catch (e) {
		opts.log("[routing] dry-run failed", { error: String(e) });
	}
}

async function readPlanIfPresent(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if (errnoCode(e) === "ENOENT") return "";
		throw e;
	}
}

const OpenSliceSchema = Type.Object({
	sliceId: Type.String(),
	sliceNumber: Type.Number(),
	milestoneNumber: Type.Number(),
	title: Type.Union([Type.String(), Type.Null()]),
});
type OpenSlice = Static<typeof OpenSliceSchema>;

function findOpenSlice(db: Database.Database): OpenSlice | null {
	const raw: unknown = db
		.prepare(
			`SELECT s.id AS sliceId, s.number AS sliceNumber, s.title AS title, m.number AS milestoneNumber
			 FROM slice s JOIN milestone m ON s.milestone_id = m.id
			 WHERE s.status != 'closed'
			 ORDER BY s.created_at DESC LIMIT 1`,
		)
		.get();
	if (raw === undefined) return null;
	if (!Value.Check(OpenSliceSchema, raw)) {
		throw new Error("findOpenSlice: row shape invalid");
	}
	return raw;
}
