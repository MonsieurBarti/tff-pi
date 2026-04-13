import { describe, expect, it } from "vitest";
import { parseVerificationClaims } from "../../../src/common/evidence-auditor.js";

describe("parseVerificationClaims", () => {
	it("returns [] for empty input", () => {
		expect(parseVerificationClaims("")).toEqual([]);
	});

	it("parses backticked command with 'all pass' keyword (expectedExit=0)", () => {
		const md = "Ran `bun run test` — all 677 tests pass.";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run test", expectedExit: 0 });
	});

	it("parses backticked command with explicit 'exit 1'", () => {
		const md = "`bun run test` exit 1";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run test", expectedExit: 1 });
	});

	it("parses fenced-block '$ <cmd>' with clean output as expectedExit=0", () => {
		const md = "```\n$ bun run typecheck\n```\n";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "bun run typecheck", expectedExit: 0 });
	});

	it("parses fenced-block '$ <cmd>' with 'error:' in output as expectedExit=1", () => {
		const md = "```\n$ foo\nerror: bar\n```\n";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "foo", expectedExit: 1 });
	});

	it("parses AC checkbox [x] with backticked command as expectedExit=0", () => {
		const md = "- [x] AC-3: verified via `rg setCurrentPhase src/`";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "rg setCurrentPhase src/", expectedExit: 0 });
	});

	it("parses AC checkbox [ ] with backticked command as expectedExit=1", () => {
		const md = "- [ ] AC-4: could not verify via `rg foo`";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ command: "rg foo", expectedExit: 1 });
	});

	it("ignores very short backticked tokens (< 3 chars) and empty backticks", () => {
		const md = "Ran `` which pass. Then `x` failed.";
		const claims = parseVerificationClaims(md);
		expect(claims).toHaveLength(0);
	});
});
