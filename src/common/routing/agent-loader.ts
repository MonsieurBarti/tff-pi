import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentCapabilityParseError, parseAgentCapability } from "./agent-capability-parser.js";
import type { AgentCapability } from "./agent-capability.js";
import { errnoCode } from "./fs-helpers.js";

export class AgentLoadError extends Error {
	constructor(
		message: string,
		public readonly code: "AGENT_NOT_FOUND" | "INVALID_FRONTMATTER",
		public readonly agent_id: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "AgentLoadError";
	}
}

async function tryRead(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if (errnoCode(e) === "ENOENT") return null;
		throw e;
	}
}

export async function readAgentCapability(
	root: string,
	agent_id: string,
): Promise<AgentCapability> {
	const projectPath = join(root, ".pi", "agents", `${agent_id}.md`);
	const bundledPath = join(root, "src", "resources", "agents", `${agent_id}.md`);
	const text = (await tryRead(projectPath)) ?? (await tryRead(bundledPath));
	if (text === null) {
		throw new AgentLoadError(
			`agent file not found for "${agent_id}" (looked in ${projectPath} and ${bundledPath})`,
			"AGENT_NOT_FOUND",
			agent_id,
		);
	}
	try {
		return parseAgentCapability(text, agent_id);
	} catch (e) {
		if (e instanceof AgentCapabilityParseError) {
			throw new AgentLoadError(
				`invalid frontmatter for "${agent_id}": ${e.message}`,
				"INVALID_FRONTMATTER",
				agent_id,
				{ cause: e },
			);
		}
		throw e;
	}
}
