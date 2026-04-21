import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	insertMilestone,
	insertProject,
	insertSlice,
	openDatabase,
} from "../../../src/common/db.js";
import { gitEnv } from "../../../src/common/git.js";
import { PerSliceLog } from "../../../src/common/per-slice-log.js";
import {
	diagnoseRecovery,
	formatRecoveryBriefing,
	scanForStuckSlices,
	summarizeInput,
} from "../../../src/common/recovery.js";

function getProjectId(db: Database.Database): string {
	const row = db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string };
	return row.id;
}

describe("recovery", () => {
	let root: string;
	let db: Database.Database;
	let savedEnv: Record<string, string | undefined> = {};

	function seedToolCall(
		sliceId: string,
		opts: {
			command: string;
			toolName?: string;
			isError?: boolean;
			startedAt?: string;
			durationMs?: number;
		},
	): void {
		const startedAt = opts.startedAt ?? new Date().toISOString();
		const bus = {
			handlers: new Map<string, Array<(d: unknown) => void>>(),
			on(channel: string, fn: (d: unknown) => void) {
				const list = this.handlers.get(channel) ?? [];
				list.push(fn);
				this.handlers.set(channel, list);
				return () => {};
			},
			emit(channel: string, data: unknown) {
				for (const fn of this.handlers.get(channel) ?? []) fn(data);
			},
		};
		const log = new PerSliceLog(root);
		log.subscribe(bus);
		bus.emit("tff:tool", {
			timestamp: startedAt,
			type: "tool_call",
			sliceId,
			sliceLabel: "M01-S01",
			milestoneNumber: 1,
			phase: "execute",
			toolCallId: `c-${Math.random().toString(36).slice(2, 10)}`,
			toolName: opts.toolName ?? "bash",
			input: { command: opts.command },
			output: opts.isError ? "fail" : "ok",
			isError: opts.isError ?? false,
			durationMs: opts.durationMs ?? 10,
			startedAt,
		});
		log.dispose();
	}

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("GIT_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		root = join(tmpdir(), `tff-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, ".pi", ".tff"), { recursive: true });

		const env = gitEnv();
		execFileSync("git", ["init"], { cwd: root, env });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, env });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root, env });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root, env });

		db = openDatabase(join(root, ".pi", ".tff", "state.db"));
		applyMigrations(db);
		insertProject(db, { name: "TestProj", vision: "Testing" });
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });

		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			}
		}
		savedEnv = {};
	});

	describe("scanForStuckSlices", () => {
		it("returns empty array when no slices are stuck", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			expect(scanForStuckSlices(db)).toEqual([]);
		});

		it("detects slices in transitional states", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const stuck = scanForStuckSlices(db);
			expect(stuck).toHaveLength(1);
			expect(stuck[0]?.status).toBe("executing");
		});

		it("ignores created and closed slices", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			const s2 = insertSlice(db, { milestoneId: mId, number: 2, title: "S2" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("closed", s2);

			expect(scanForStuckSlices(db)).toEqual([]);
		});
	});

	describe("diagnoseRecovery", () => {
		it("returns resume for discussing status", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("discussing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("resume");
		});

		it("returns manual when executing with no worktree", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("manual");
		});

		it("returns manual for shipping status", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("shipping", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.classification).toBe("manual");
		});

		it("gathers artifact evidence", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("verifying", sId);

			const sliceDir = join(root, ".pi", ".tff", "milestones", "M01", "slices", "M01-S01");
			mkdirSync(sliceDir, { recursive: true });
			writeFileSync(join(sliceDir, "SPEC.md"), "spec", "utf-8");
			writeFileSync(join(sliceDir, "PLAN.md"), "plan", "utf-8");

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.artifacts).toContain("SPEC.md");
			expect(diag.evidence.artifacts).toContain("PLAN.md");
		});

		it("recentToolCalls is empty when the slice has no tff:tool events", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.recentToolCalls).toEqual([]);
		});

		it("recentToolCalls returns at most 10 rows in chronological order (oldest first)", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const now = Date.now();
			for (let i = 0; i < 15; i++) {
				seedToolCall(sId, {
					command: `cmd-${i}`,
					startedAt: new Date(now - (15 - i) * 1000).toISOString(),
				});
			}

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.recentToolCalls).toHaveLength(10);
			expect(diag.evidence.recentToolCalls[0]?.commandSummary).toBe("cmd-5");
			expect(diag.evidence.recentToolCalls[9]?.commandSummary).toBe("cmd-14");
		});

		it("recentToolCalls excludes events outside the 30-min window when fresh events exist", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const now = Date.now();
			seedToolCall(sId, {
				command: "ancient",
				startedAt: new Date(now - 90 * 60 * 1000).toISOString(),
			});
			seedToolCall(sId, {
				command: "recent",
				startedAt: new Date(now - 60 * 1000).toISOString(),
			});

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.recentToolCalls).toHaveLength(1);
			expect(diag.evidence.recentToolCalls[0]?.commandSummary).toBe("recent");
		});

		it("recentToolCalls falls back to last N overall when no events are within the window", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const now = Date.now();
			seedToolCall(sId, {
				command: "old-1",
				startedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
			});
			seedToolCall(sId, {
				command: "old-2",
				startedAt: new Date(now - 2.5 * 60 * 60 * 1000).toISOString(),
			});

			const diag = diagnoseRecovery(root, db, sId, 1);
			expect(diag.evidence.recentToolCalls).toHaveLength(2);
			expect(diag.evidence.recentToolCalls[0]?.commandSummary).toBe("old-1");
			expect(diag.evidence.recentToolCalls[1]?.commandSummary).toBe("old-2");
		});
	});

	describe("summarizeInput", () => {
		it("returns empty string for null or non-object input", () => {
			expect(summarizeInput("bash", null)).toBe("");
			expect(summarizeInput("bash", undefined)).toBe("");
			expect(summarizeInput("bash", "not an object")).toBe("");
			expect(summarizeInput("bash", 42)).toBe("");
		});

		it("returns the bash command, truncating at 80 chars", () => {
			expect(summarizeInput("bash", { command: "bun run test" })).toBe("bun run test");
			const long = "a".repeat(100);
			const result = summarizeInput("bash", { command: long });
			expect(result.length).toBeLessThanOrEqual(81);
			expect(result.endsWith("…")).toBe(true);
		});

		it("returns path for write/edit/notebook_edit tools", () => {
			expect(summarizeInput("write", { path: "src/foo.ts" })).toBe("src/foo.ts");
			expect(summarizeInput("edit", { file_path: "src/bar.ts" })).toBe("src/bar.ts");
			expect(summarizeInput("notebook_edit", { path: "note.ipynb" })).toBe("note.ipynb");
		});

		it("returns artifact label for tff_write_* tools", () => {
			expect(summarizeInput("tff_write_spec", { content: "..." })).toBe("SPEC.md");
			expect(summarizeInput("tff_write_plan", { content: "..." })).toBe("PLAN.md");
		});

		it("falls back to truncated JSON for unknown tools with object input", () => {
			const result = summarizeInput("mystery_tool", { a: 1, b: 2 });
			expect(result).toContain("a");
			expect(result).toContain("1");
			expect(result.length).toBeLessThanOrEqual(81);
		});

		it("strips ANSI escape sequences from bash commands", () => {
			const cmd = "bun test \x1b[31mFAIL\x1b[0m";
			expect(summarizeInput("bash", { command: cmd })).toBe("bun test FAIL");
		});

		it("replaces control characters with spaces", () => {
			const cmd = "echo foo\x00bar\r\nbaz";
			// NUL, CR, LF each become a single space.
			expect(summarizeInput("bash", { command: cmd })).toBe("echo foo bar  baz");
		});

		it("does not split a UTF-16 surrogate pair at the truncation boundary", () => {
			// Emoji "🎉" is U+1F389, encoded as the surrogate pair D83C+DF89 (2 UTF-16 units).
			// Build a 79-char prefix + emoji; truncate at 80 would split the surrogate.
			const prefix = "a".repeat(79);
			const cmd = `${prefix}🎉tail`;
			const result = summarizeInput("bash", { command: cmd });
			// Truncator drops the high surrogate, appends ellipsis at position 79.
			expect(result).toBe(`${"a".repeat(79)}…`);
			expect(result.length).toBeLessThanOrEqual(80);
		});
	});

	describe("formatRecoveryBriefing", () => {
		it("renders a Recent tool calls section when evidence has entries", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			seedToolCall(sId, {
				command: "bun run test",
				isError: true,
				durationMs: 4200,
				startedAt: "2026-04-13T12:06:01.000Z",
			});

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			expect(briefing).toContain("### Recent tool calls (last 1)");
			expect(briefing).toContain("bash");
			expect(briefing).toContain("bun run test");
			expect(briefing).toContain("✗");
			expect(briefing).toContain("12:06:01");
			expect(briefing).toContain("(4.2s)");
		});

		it("escapes backticks in commandSummary so the rendered span can't break out", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			seedToolCall(sId, {
				command: "bash -c 'echo `date`'",
				startedAt: "2026-04-13T12:00:00.000Z",
			});

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			// Rendered span should NOT contain a literal backtick inside the
			// inline-code wrapper. Substitute with ASCII single-quote.
			expect(briefing).toContain("'echo 'date''");
			expect(briefing).not.toContain("`echo `date``");
		});

		it("omits the Recent tool calls section entirely when evidence is empty", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			expect(briefing).not.toContain("Recent tool calls");
		});

		it("briefing opens with a RECOVERY-GATE block that forbids non-/tff-recover actions", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			// Hard-gate markers must appear at the top.
			expect(briefing.startsWith("<RECOVERY-GATE>")).toBe(true);
			expect(briefing).toContain("</RECOVERY-GATE>");
			// Explicitly whitelist ONLY the two recovery commands.
			expect(briefing).toContain("/tff recover resume");
			expect(briefing).toContain("/tff recover dismiss");
			// Explicitly forbid inline tool use (the prior failure mode that
			// led to /gh pr create --base main and bypassed task closure).
			expect(briefing).toMatch(/Do NOT invoke any other tool/);
			expect(briefing).toMatch(/bash, git, gh/);
			expect(briefing).toMatch(/tff_\*/);
		});

		it("briefing no longer suggests inline git work (regression for the recovery-bypass bug)", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("executing", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			// The old "Git discipline reminder" positively encouraged inline
			// git add/commit work outside the orchestrator. That section is gone.
			expect(briefing).not.toMatch(/Git discipline/i);
			expect(briefing).not.toContain("git add");
			expect(briefing).not.toMatch(/can be re-run safely/i);
		});

		it("final instruction is imperative and terminal (EXACTLY ONE)", () => {
			const mId = insertMilestone(db, {
				projectId: getProjectId(db),
				number: 1,
				name: "M1",
				branch: "milestone/M01",
			});
			const sId = insertSlice(db, { milestoneId: mId, number: 1, title: "S1" });
			db.prepare("UPDATE slice SET status = ? WHERE id = ?").run("planning", sId);

			const diag = diagnoseRecovery(root, db, sId, 1);
			const briefing = formatRecoveryBriefing(diag);

			expect(briefing).toMatch(/EXACTLY ONE of/);
			expect(briefing).toMatch(/No other command or tool call is permitted/);
		});
	});
});
