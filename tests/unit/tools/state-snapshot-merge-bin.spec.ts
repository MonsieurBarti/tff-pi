import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "../../../src/common/state-exporter.js";

const BIN = join(process.cwd(), "src/tools/state-snapshot-merge.ts");

function makeSnap(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		exportedAt: "2026-04-14T00:00:00.000Z",
		project: [],
		milestone: [],
		slice: [],
		task: [],
		dependency: [],
		phase_run: [],
		...overrides,
	};
}

describe("state-snapshot-merge bin", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tff-mergebin-"));
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	function write(name: string, snap: Snapshot): string {
		const p = join(tmp, name);
		writeFileSync(p, `${JSON.stringify(snap, null, 2)}\n`);
		return p;
	}

	it("exits 0 and writes merged snapshot on clean merge", () => {
		const base = write("O", makeSnap());
		const row = { id: "p", name: "N", vision: "V", createdAt: "t" };
		const ours = write("A", makeSnap({ project: [row] as unknown as Snapshot["project"] }));
		const theirs = write("B", makeSnap());
		const result = spawnSync("bun", [BIN, base, ours, theirs, "state-snapshot.json"], {
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const written = JSON.parse(readFileSync(ours, "utf-8"));
		expect(written.project).toHaveLength(1);
	});

	it("exits 1 and prints conflicts on unresolvable merge", () => {
		const baseSnap = makeSnap({
			project: [
				{ id: "p", name: "A", vision: "V", createdAt: "t" },
			] as unknown as Snapshot["project"],
		});
		const oursSnap = makeSnap({
			project: [
				{ id: "p", name: "B", vision: "V", createdAt: "t" },
			] as unknown as Snapshot["project"],
		});
		const theirsSnap = makeSnap({
			project: [
				{ id: "p", name: "C", vision: "V", createdAt: "t" },
			] as unknown as Snapshot["project"],
		});
		const O = write("O", baseSnap);
		const A = write("A", oursSnap);
		const B = write("B", theirsSnap);
		const result = spawnSync("bun", [BIN, O, A, B, "state-snapshot.json"], { encoding: "utf-8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("project");
		expect(result.stderr).toContain("name");
	});

	it("exits 1 with a schema-mismatch message on bad schemaVersion", () => {
		const tooOld = join(tmp, "old.json");
		writeFileSync(tooOld, JSON.stringify({ schemaVersion: 0, exportedAt: "t" }, null, 2));
		const ok = write("A", makeSnap());
		const result = spawnSync("bun", [BIN, tooOld, ok, ok, "state-snapshot.json"], {
			encoding: "utf-8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/schema/i);
	});

	it("exits 1 with a JSON-parse error on malformed input", () => {
		const bad = join(tmp, "bad.json");
		writeFileSync(bad, "not valid json", "utf-8");
		const ok = write("A", makeSnap());
		const result = spawnSync("bun", [BIN, bad, ok, ok, "state-snapshot.json"], {
			encoding: "utf-8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr.toLowerCase()).toMatch(/json/);
	});
});
