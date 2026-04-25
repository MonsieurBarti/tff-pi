import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSliceDir, sliceDir } from "../../../../src/common/artifacts.js";
import {
	readSignals,
	signalsPath,
	writeSignals,
} from "../../../../src/common/routing/signal-store.js";
import type { Signals } from "../../../../src/common/routing/signals.js";

describe("signal-store", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-signals-"));
		initSliceDir(root, 2, 1); // M02-S01
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const sample: Signals = {
		complexity: "medium",
		risk: { level: "high", tags: ["auth", "migrations"] },
	};

	it("writes to .pi/.tff/milestones/M02/slices/M02-S01/signals.json", async () => {
		await writeSignals(root, 2, 1, sample);
		const path = signalsPath(root, 2, 1);
		expect(path).toBe(join(sliceDir(root, 2, 1), "signals.json"));
		expect(existsSync(path)).toBe(true);
	});

	it("round-trips equal value (AC-05)", async () => {
		await writeSignals(root, 2, 1, sample);
		const read = await readSignals(root, 2, 1);
		expect(read).toEqual(sample);
	});

	it("returns null on ENOENT (AC-05)", async () => {
		const r = await readSignals(root, 2, 99);
		expect(r).toBeNull();
	});

	it("throws on malformed JSON (fail-fast)", async () => {
		mkdirSync(sliceDir(root, 2, 1), { recursive: true });
		writeFileSync(signalsPath(root, 2, 1), "{not json", "utf8");
		await expect(readSignals(root, 2, 1)).rejects.toThrow();
	});

	it("throws on schema-violating JSON (fail-fast via Value.Parse)", async () => {
		writeFileSync(
			signalsPath(root, 2, 1),
			JSON.stringify({ complexity: "critical", risk: { level: "low", tags: [] } }),
			"utf8",
		);
		await expect(readSignals(root, 2, 1)).rejects.toThrow();
	});
});
