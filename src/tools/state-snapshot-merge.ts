#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { mergeSnapshots } from "../common/snapshot-merge.js";
import { SnapshotSchemaError, readSnapshot, serializeSnapshot } from "../common/state-exporter.js";

function main(argv: string[]): number {
	if (argv.length < 4) {
		process.stderr.write("usage: state-snapshot-merge <base> <ours> <theirs> [path]\n");
		return 2;
	}
	const basePath = argv[0] as string;
	const oursPath = argv[1] as string;
	const theirsPath = argv[2] as string;
	try {
		const base = readSnapshot(basePath);
		const ours = readSnapshot(oursPath);
		const theirs = readSnapshot(theirsPath);
		const result = mergeSnapshots(base, ours, theirs);
		if (!result.ok) {
			for (const c of result.conflicts) {
				process.stderr.write(
					`conflict: table=${c.table} id=${c.id} field=${c.field} ` +
						`base=${JSON.stringify(c.base)} ours=${JSON.stringify(c.ours)} theirs=${JSON.stringify(c.theirs)}\n`,
				);
			}
			return 1;
		}
		writeFileSync(oursPath, serializeSnapshot(result.merged), "utf-8");
		return 0;
	} catch (e) {
		if (e instanceof SnapshotSchemaError) {
			process.stderr.write(`${e.message}\n`);
		} else {
			process.stderr.write(`state-snapshot-merge: ${(e as Error).message}\n`);
		}
		return 1;
	}
}

process.exit(main(process.argv.slice(2)));
