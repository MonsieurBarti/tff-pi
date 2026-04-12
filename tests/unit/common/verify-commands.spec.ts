import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../../../src/common/settings.js";
import { DEFAULT_SETTINGS } from "../../../src/common/settings.js";
import { detectVerifyCommands } from "../../../src/common/verify-commands.js";

describe("verify-commands", () => {
	let root: string;

	// Settings with auto-detection explicitly enabled (opt-in).
	const AUTO: Settings = {
		...DEFAULT_SETTINGS,
		compress: { ...DEFAULT_SETTINGS.compress },
		ship: { ...DEFAULT_SETTINGS.ship },
		verify_auto_detect: true,
	};

	beforeEach(() => {
		root = join(tmpdir(), `tff-verify-cmd-${Date.now()}`);
		mkdirSync(root, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns settings.verify_commands when configured", () => {
		const settings: Settings = {
			...DEFAULT_SETTINGS,
			compress: { ...DEFAULT_SETTINGS.compress },
			ship: { ...DEFAULT_SETTINGS.ship },
			verify_commands: [{ name: "test", command: "bun test" }],
		};
		const cmds = detectVerifyCommands(root, settings);
		expect(cmds).toEqual([{ name: "test", command: "bun test", source: "settings" }]);
	});

	it("returns empty array by default (no auto-detection without opt-in)", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest",
					lint: "biome check",
				},
			}),
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, DEFAULT_SETTINGS);
		expect(cmds).toEqual([]);
	});

	it("auto-detects when verify_auto_detect is true", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest",
				},
			}),
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, AUTO);
		expect(cmds.length).toBeGreaterThan(0);
		expect(cmds.some((c) => c.command === "vitest")).toBe(true);
	});

	it("detects commands from package.json scripts", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest",
					lint: "biome check",
					typecheck: "tsc --noEmit",
				},
			}),
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, AUTO);
		expect(cmds).toHaveLength(3);
		expect(cmds.find((c) => c.name === "test")?.command).toBe("vitest");
		expect(cmds.find((c) => c.name === "lint")?.command).toBe("biome check");
		expect(cmds.find((c) => c.name === "typecheck")?.command).toBe("tsc --noEmit");
		expect(cmds.every((c) => c.source === "package.json")).toBe(true);
	});

	it("detects commands from GitHub Actions workflow", () => {
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(root, ".github", "workflows", "ci.yml"),
			"name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n      - run: tsc --noEmit\n",
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, AUTO);
		expect(cmds.length).toBeGreaterThanOrEqual(2);
		expect(cmds.some((c) => c.command === "bun test")).toBe(true);
		expect(cmds.some((c) => c.command === "tsc --noEmit")).toBe(true);
		expect(cmds.every((c) => c.source === "ci")).toBe(true);
	});

	it("detects commands from lefthook.yml", () => {
		writeFileSync(
			join(root, "lefthook.yml"),
			"pre-commit:\n  commands:\n    lint:\n      run: biome check --write .\n    types:\n      run: tsc --noEmit\n",
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, AUTO);
		expect(cmds.some((c) => c.command.includes("biome check"))).toBe(true);
		expect(cmds.every((c) => c.source === "hooks")).toBe(true);
	});

	it("returns empty array when nothing is detectable", () => {
		const cmds = detectVerifyCommands(root, AUTO);
		expect(cmds).toEqual([]);
	});

	it("settings.verify_commands takes precedence over auto-detection", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "vitest" } }),
			"utf-8",
		);
		const settings: Settings = {
			...DEFAULT_SETTINGS,
			compress: { ...DEFAULT_SETTINGS.compress },
			ship: { ...DEFAULT_SETTINGS.ship },
			verify_commands: [{ name: "custom", command: "my-test" }],
			verify_auto_detect: true,
		};
		const cmds = detectVerifyCommands(root, settings);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.command).toBe("my-test");
	});

	it("deduplicates commands with same command string", () => {
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(root, ".github", "workflows", "ci.yml"),
			"name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
			"utf-8",
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "bun test" } }),
			"utf-8",
		);
		const cmds = detectVerifyCommands(root, AUTO);
		const bunTestCmds = cmds.filter((c) => c.command === "bun test");
		expect(bunTestCmds).toHaveLength(1);
	});
});
