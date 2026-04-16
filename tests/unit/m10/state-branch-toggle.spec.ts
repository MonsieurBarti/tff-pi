import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isAutoDetectRenameEnabled,
	isStateBranchEnabledForRoot,
} from "../../../src/common/state-branch-toggle.js";

function makeRoot(settingsYaml?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tff-toggle-"));
	mkdirSync(join(dir, ".tff"), { recursive: true });
	if (settingsYaml !== undefined) {
		writeFileSync(join(dir, ".tff", "settings.yaml"), settingsYaml, "utf-8");
	}
	return dir;
}

describe("state-branch-toggle", () => {
	it("returns false when settings.yaml missing", () => {
		const root = makeRoot();
		try {
			expect(isStateBranchEnabledForRoot(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns true when enabled: true", () => {
		const root = makeRoot("state_branch:\n  enabled: true\n");
		try {
			expect(isStateBranchEnabledForRoot(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns false when enabled: false", () => {
		const root = makeRoot("state_branch:\n  enabled: false\n");
		try {
			expect(isStateBranchEnabledForRoot(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns false when state_branch key absent", () => {
		const root = makeRoot("model_profile: balanced\n");
		try {
			expect(isStateBranchEnabledForRoot(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("auto_detect_rename defaults true when absent", () => {
		const root = makeRoot("state_branch:\n  enabled: true\n");
		try {
			expect(isAutoDetectRenameEnabled(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("auto_detect_rename respects false", () => {
		const root = makeRoot("state_branch:\n  enabled: true\n  auto_detect_rename: false\n");
		try {
			expect(isAutoDetectRenameEnabled(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
