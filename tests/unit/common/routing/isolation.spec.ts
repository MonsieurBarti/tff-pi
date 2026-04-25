import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TARGETS = [
	"src/phases",
	"src/commands",
	"src/index.ts",
	"src/lifecycle.ts",
	"src/orchestrator.ts",
];

describe("AC-09: routing module is not consumed yet", () => {
	it("all isolation grep targets exist (guard against vacuous pass)", () => {
		for (const t of TARGETS) {
			expect(existsSync(join(process.cwd(), t)), `missing: ${t}`).toBe(true);
		}
	});

	it("no phase / command / orchestrator / lifecycle / index imports common/routing", () => {
		// grep returns exit code 1 when no matches → child_process throws.
		// Success only if grep finds nothing.
		let output = "";
		try {
			output = execSync(`grep -rn "common/routing" ${TARGETS.join(" ")}`, {
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "ignore"],
			}).toString();
		} catch {
			output = ""; // no matches → grep exit 1 → caught here
		}
		expect(output.trim()).toBe("");
	});
});
