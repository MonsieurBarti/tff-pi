import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStateRename } from "../../../src/commands/state-rename.js";
import type { TffContext } from "../../../src/common/context.js";
import { ensureStateBranch } from "../../../src/common/state-branch.js";
import { type TwoClone, makeTwoClone } from "../../helpers/git-state-fixtures.js";
import { seedEnabledSettings } from "../../helpers/settings.js";

function makePi() {
	const messages: string[] = [];
	const emittedEvents: Array<{ channel: string; data: unknown }> = [];
	return {
		messages,
		emittedEvents,
		sendUserMessage: (s: string) => messages.push(s),
		events: {
			emit: (channel: string, data: unknown) => emittedEvents.push({ channel, data }),
			on: () => () => {},
		},
	} as unknown as ExtensionAPI & {
		messages: string[];
		emittedEvents: Array<{ channel: string; data: unknown }>;
	};
}

function makeCtx(root: string): TffContext {
	return { projectRoot: root } as unknown as TffContext;
}

describe("integration: /tff state rename remote push/delete", () => {
	let fx: TwoClone;

	beforeEach(async () => {
		fx = await makeTwoClone();
		seedEnabledSettings(fx.alice);

		// Alice checks out feature/origin, ensures the state branch, then pushes it
		// to origin so the remote ref exists before the rename.
		execSync("git checkout -b feature/origin", { cwd: fx.alice, stdio: "pipe" });
		await ensureStateBranch(fx.alice, fx.aliceProjectId);
		execSync("git push -u origin tff-state/feature/origin", { cwd: fx.alice, stdio: "pipe" });
	});

	afterEach(() => {
		fx.cleanup();
	});

	it("publishes new state branch and deletes old one on origin", async () => {
		execSync("git branch -m feature/renamed", { cwd: fx.alice, stdio: "pipe" });

		const pi = makePi();
		await runStateRename(pi, makeCtx(fx.alice), null, ["feature/renamed"]);

		expect(pi.messages.join("\n")).not.toMatch(/^Error/im);

		const remoteRefs = execSync("git ls-remote origin 'refs/heads/tff-state/*'", {
			cwd: fx.alice,
			encoding: "utf-8",
		}).trim();

		expect(remoteRefs).toMatch(/tff-state\/feature\/renamed/);
		expect(remoteRefs).not.toMatch(/tff-state\/feature\/origin/);
	});

	it("emits tff:state-rename event with all required fields", async () => {
		execSync("git branch -m feature/renamed", { cwd: fx.alice, stdio: "pipe" });

		const pi = makePi();
		await runStateRename(pi, makeCtx(fx.alice), null, ["feature/renamed"]);

		const stateEvents = pi.emittedEvents.filter((e) => e.channel === "tff:state-rename");
		expect(stateEvents).toHaveLength(1);

		const data = stateEvents[0]?.data as {
			type: string;
			projectId: string;
			oldCodeBranch: string;
			newCodeBranch: string;
			oldStateBranch: string;
			newStateBranch: string;
			timestamp: string;
		};

		expect(data.type).toBe("state_rename");
		expect(data.projectId).toBe(fx.aliceProjectId);
		expect(data.oldCodeBranch).toBe("feature/origin");
		expect(data.newCodeBranch).toBe("feature/renamed");
		expect(data.oldStateBranch).toBe("tff-state/feature/origin");
		expect(data.newStateBranch).toBe("tff-state/feature/renamed");
		expect(typeof data.timestamp).toBe("string");
		expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});
