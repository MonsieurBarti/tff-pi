import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateAffectedFiles } from "../../../../src/common/routing/affected-files.js";

const FIXTURE_ROOT = join(process.cwd(), "tests/fixtures/routing");

describe("estimateAffectedFiles", () => {
	it("returns zero estimate for empty input (AC-07)", () => {
		expect(estimateAffectedFiles("")).toEqual({ files: [], taskCount: 0, count: 0 });
	});

	it("uses files.length when files > taskCount (AC-06 case A)", () => {
		const text = `
## Task T01: a
- src/a.ts
- src/b.ts
## Task T02: b
- src/c.ts
- tests/d.spec.ts
## Task T03: c
- src/e.ts
`;
		const r = estimateAffectedFiles(text);
		expect(r.taskCount).toBe(3);
		expect(r.files).toHaveLength(5);
		expect(r.count).toBe(5);
	});

	it("uses taskCount when taskCount > files (AC-06 case B)", () => {
		const text = `
## Task T01: a
## Task T02: b
## Task T03: c
## Task T04: d
## Task T05: e
## Task T06: f
- src/only-a.ts
- src/only-b.ts
`;
		const r = estimateAffectedFiles(text);
		expect(r.taskCount).toBe(6);
		expect(r.files).toHaveLength(2);
		expect(r.count).toBe(6);
	});

	it("dedupes file paths", () => {
		const text = `
## Task T01
- src/a.ts
- src/a.ts
- src/b.ts
`;
		const r = estimateAffectedFiles(text);
		expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(r.count).toBe(2);
	});

	it("matches numbered + ### task headers", () => {
		const text = `
### Task T01
1. Task one
2. Task two
## Task T02
`;
		const r = estimateAffectedFiles(text);
		expect(r.taskCount).toBeGreaterThanOrEqual(2);
	});

	it("golden: parses a realistic tff-style PLAN.md", () => {
		const planText = readFileSync(join(FIXTURE_ROOT, "golden-PLAN.md"), "utf8");
		const r = estimateAffectedFiles(planText);
		// Stable counts pinned by curated fixture; see fixture comment header.
		expect(r.taskCount).toBe(3);
		expect(r.files).toEqual(
			expect.arrayContaining([
				"src/common/foo.ts",
				"tests/unit/common/foo.spec.ts",
				"src/phases/bar.ts",
				"tests/unit/common/baz.spec.ts",
			]),
		);
		expect(r.files.length).toBe(4);
		expect(new Set(r.files).size).toBe(r.files.length); // dedup property
		expect(r.count).toBe(4); // max(3, 4)
	});
});
