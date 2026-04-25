import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideAndAudit } from "../../../../src/common/routing/decide-and-audit.js";
import { readAuditRows } from "../../../../src/common/routing/routing-audit-log.js";
import type {
	ExtractInput,
	SignalExtractor,
} from "../../../../src/common/routing/signal-extractor.js";
import { readSignals } from "../../../../src/common/routing/signal-store.js";
import type { Signals } from "../../../../src/common/routing/signals.js";

class FakeExtractor implements SignalExtractor {
	async extract(_in: ExtractInput): Promise<Signals> {
		return { complexity: "low", risk: { level: "low", tags: [] } };
	}
}

describe("decideAndAudit", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tff-orch-"));
		mkdirSync(join(root, ".pi/.tff"), { recursive: true });
		mkdirSync(join(root, "src/resources/agents"), { recursive: true });
		copyFileSync(
			"src/resources/agents/tff-code-reviewer.md",
			join(root, "src/resources/agents/tff-code-reviewer.md"),
		);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("AC-08: writes 2N rows + signals.json with stable ts+uuids", async () => {
		const input = {
			slice_id: "Xid",
			milestone_number: 99,
			slice_number: 1,
			phase: "review" as const,
			dry_run: true,
			extract_input: {
				slice_id: "Xid",
				spec_path: "/dev/null",
				plan_path: "/dev/null",
				affected_files: [],
				description: "",
			},
		};
		let n = 0;
		const result = await decideAndAudit(input, {
			root,
			extractor: new FakeExtractor(),
			now: () => new Date("2026-04-25T00:00:00.000Z"),
			uuid: () => `u${++n}`,
		});
		expect(result.decisions).toHaveLength(1);
		expect(result.decisions[0]?.agent_id).toBe("tff-code-reviewer");

		const rows = await readAuditRows(root);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.kind).toBe("route");
		expect(rows[1]?.kind).toBe("tier");
		expect(rows.every((r) => r.dry_run === true)).toBe(true);
		expect(rows.every((r) => r.slice_id === "Xid")).toBe(true);
		expect(rows.every((r) => r.timestamp === "2026-04-25T00:00:00.000Z")).toBe(true);

		expect(await readSignals(root, 99, 1)).toEqual({
			complexity: "low",
			risk: { level: "low", tags: [] },
		});
	});

	it("AC-08b: enabled+no policy → tier null + policy_tier null on every row", async () => {
		writeFileSync(join(root, ".pi/.tff/settings.yaml"), "routing:\n  enabled: true\n");
		let n = 0;
		const result = await decideAndAudit(
			{
				slice_id: "X",
				milestone_number: 1,
				slice_number: 1,
				phase: "review",
				extract_input: {
					slice_id: "X",
					spec_path: "",
					plan_path: "",
					affected_files: [],
					description: "",
				},
			},
			{ root, extractor: new FakeExtractor(), now: () => new Date(0), uuid: () => `u${++n}` },
		);
		expect(result.decisions[0]?.tier).toBeNull();
		expect(result.decisions[0]?.policy_tier).toBeNull();
		expect(result.decisions[0]?.min_tier_applied).toBe(false);
		const rows = await readAuditRows(root);
		const tierRow = rows.find((r) => r.kind === "tier");
		expect(tierRow?.kind === "tier" && tierRow.tier).toBeNull();
		expect(tierRow?.kind === "tier" && tierRow.policy_tier).toBeNull();
	});

	it("two consecutive calls append", async () => {
		const input = {
			slice_id: "X",
			milestone_number: 1,
			slice_number: 1,
			phase: "review" as const,
			extract_input: {
				slice_id: "X",
				spec_path: "",
				plan_path: "",
				affected_files: [],
				description: "",
			},
		};
		let n = 0;
		const deps = {
			root,
			extractor: new FakeExtractor(),
			now: () => new Date(0),
			uuid: () => `u${++n}`,
		};
		await decideAndAudit(input, deps);
		await decideAndAudit(input, deps);
		expect((await readAuditRows(root)).length).toBe(4);
	});
});
