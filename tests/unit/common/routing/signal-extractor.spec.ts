import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemSignalExtractor } from "../../../../src/common/routing/signal-extractor.js";

const FIXTURE_ROOT = join(process.cwd(), "tests/fixtures/routing");

describe("FilesystemSignalExtractor", () => {
	const extractor = new FilesystemSignalExtractor();

	it("AC-02: tags are sorted; auth+migration spec → tags=[auth,migrations]", async () => {
		const r = await extractor.extract({
			slice_id: "fx",
			spec_path: join(FIXTURE_ROOT, "slice-risky-migration/SPEC.md"),
			affected_files: [],
			description: "",
		});
		expect(r.complexity).toBe("low");
		expect(r.risk.level).toBe("high");
		expect(r.risk.tags).toEqual(["auth", "migrations"]);
	});

	it("AC-03: complexity thresholds (4→low, 7→medium, 15→high)", async () => {
		const mk = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
		expect(
			(await extractor.extract({ slice_id: "x", affected_files: mk(4), description: "" }))
				.complexity,
		).toBe("low");
		expect(
			(await extractor.extract({ slice_id: "x", affected_files: mk(7), description: "" }))
				.complexity,
		).toBe("medium");
		expect(
			(await extractor.extract({ slice_id: "x", affected_files: mk(15), description: "" }))
				.complexity,
		).toBe("high");
	});

	it("AC-04: missing spec_path is silently empty; description supplies tags (sorted)", async () => {
		const r = await extractor.extract({
			slice_id: "fx",
			spec_path: "/does/not/exist/SPEC.md",
			affected_files: [],
			description: "secret pii breaking",
		});
		expect(r.risk.level).toBe("high");
		expect(r.risk.tags).toEqual(["breaking", "pii", "secret"]);
	});

	it("trivial fixture: low complexity, no tags", async () => {
		const r = await extractor.extract({
			slice_id: "fx-trivial",
			spec_path: join(FIXTURE_ROOT, "slice-trivial/SPEC.md"),
			affected_files: ["src/foo.ts"],
			description: "rename a local variable",
		});
		expect(r.complexity).toBe("low");
		expect(r.risk.level).toBe("low");
		expect(r.risk.tags).toEqual([]);
	});

	it("medium risk when exactly one tag matches", async () => {
		const r = await extractor.extract({
			slice_id: "fx",
			affected_files: [],
			description: "touches authentication only",
		});
		expect(r.risk.level).toBe("medium");
		expect(r.risk.tags).toEqual(["auth"]);
	});
});
