import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMechanicalVerification } from "../../../src/common/mechanical-verifier.js";
import type { VerifyCommand } from "../../../src/common/verify-commands.js";

describe("mechanical-verifier", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `tff-mech-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reports passing command", async () => {
		const commands: VerifyCommand[] = [{ name: "test", command: "echo ok", source: "settings" }];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.allPassed).toBe(true);
		expect(report.commands).toHaveLength(1);
		expect(report.commands[0]?.passed).toBe(true);
		expect(report.commands[0]?.exitCode).toBe(0);
	});

	it("reports failing command", async () => {
		const commands: VerifyCommand[] = [{ name: "fail", command: "exit 1", source: "settings" }];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.allPassed).toBe(false);
		expect(report.commands[0]?.passed).toBe(false);
		expect(report.commands[0]?.exitCode).toBe(1);
	});

	it("captures stdout and stderr", async () => {
		const commands: VerifyCommand[] = [
			{
				name: "output",
				command: "echo hello-stdout && echo hello-stderr >&2",
				source: "settings",
			},
		];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.commands[0]?.stdout).toContain("hello-stdout");
		expect(report.commands[0]?.stderr).toContain("hello-stderr");
	});

	it("runs multiple commands sequentially", async () => {
		const commands: VerifyCommand[] = [
			{ name: "first", command: "echo first", source: "settings" },
			{ name: "second", command: "echo second", source: "settings" },
		];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.commands).toHaveLength(2);
		expect(report.allPassed).toBe(true);
	});

	it("allPassed is false when any command fails", async () => {
		const commands: VerifyCommand[] = [
			{ name: "pass", command: "echo ok", source: "settings" },
			{ name: "fail", command: "exit 2", source: "settings" },
		];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.allPassed).toBe(false);
		expect(report.commands[0]?.passed).toBe(true);
		expect(report.commands[1]?.passed).toBe(false);
	});

	it("returns empty report for empty commands", async () => {
		const report = await runMechanicalVerification([], cwd);
		expect(report.allPassed).toBe(true);
		expect(report.commands).toHaveLength(0);
	});

	it("measures duration per command", async () => {
		const commands: VerifyCommand[] = [{ name: "test", command: "echo fast", source: "settings" }];
		const report = await runMechanicalVerification(commands, cwd);
		expect(report.commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});
});
