import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("scripts/checks/no-cast-asserts.mjs", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tff-no-casts-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const run = (...args: string[]) =>
		spawnSync("node", ["scripts/checks/no-cast-asserts.mjs", ...args], {
			encoding: "utf8",
		});

	it("exits 0 when no targets provided (lenient)", () => {
		expect(run().status).toBe(0);
	});
	it("exits 0 on a clean file", () => {
		const f = join(dir, "clean.ts");
		writeFileSync(f, "export const x = 1;\n");
		expect(run(f).status).toBe(0);
	});
	it("exits 1 on TSAsExpression (non-const cast)", () => {
		const f = join(dir, "cast.ts");
		writeFileSync(f, "declare const v: unknown;\nexport const x = v as string;\n");
		const r = run(f);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toContain("cast.ts");
	});
	it("exits 1 on NonNullExpression (!.)", () => {
		const f = join(dir, "bang.ts");
		writeFileSync(f, "declare const v: { y?: number };\nexport const z = v.y!;\n");
		expect(run(f).status).toBe(1);
	});
	it("ignores `as const` literal-type assertions", () => {
		const f = join(dir, "asconst.ts");
		writeFileSync(f, "export const t = { a: 1 } as const;\n");
		expect(run(f).status).toBe(0);
	});
});
