import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseYaml } from "yaml";
import { type AgentCapability, ModelTierSchema } from "./agent-capability.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
// .length is UTF-16 code units, not bytes — name reflects that.
const MAX_AGENT_TEXT_CHARS = 1024 * 1024;

const FrontmatterEnvelopeSchema = Type.Object(
	{
		routing: Type.Optional(
			Type.Object({
				handles: Type.Optional(Type.Array(Type.String())),
				priority: Type.Optional(Type.Integer()),
				min_tier: Type.Optional(ModelTierSchema),
			}),
		),
	},
	{ additionalProperties: true },
);

export class AgentCapabilityParseError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "TOO_LARGE"
			| "NO_FRONTMATTER"
			| "YAML_PARSE_ERROR"
			| "SCHEMA_VIOLATION"
			| "INVALID_ID",
		public readonly agentId: string,
	) {
		super(message);
		this.name = "AgentCapabilityParseError";
	}
}

export function parseAgentCapability(text: string, id: string): AgentCapability {
	if (!/^[a-z][a-z0-9-]*$/.test(id)) {
		throw new AgentCapabilityParseError(`invalid agent id: ${id}`, "INVALID_ID", id);
	}
	if (text.length > MAX_AGENT_TEXT_CHARS) {
		throw new AgentCapabilityParseError(`agent file too large: ${id}`, "TOO_LARGE", id);
	}

	const match = text.match(FRONTMATTER_RE);
	if (!match) {
		throw new AgentCapabilityParseError(
			`no frontmatter in agent file: ${id}`,
			"NO_FRONTMATTER",
			id,
		);
	}

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1] ?? "");
	} catch {
		throw new AgentCapabilityParseError(`yaml parse error in agent: ${id}`, "YAML_PARSE_ERROR", id);
	}

	if (!Value.Check(FrontmatterEnvelopeSchema, frontmatter)) {
		const errors = [...Value.Errors(FrontmatterEnvelopeSchema, frontmatter)].map(
			(e) => `${e.path}: ${e.message}`,
		);
		throw new AgentCapabilityParseError(
			`agent capability schema violation: ${id} — ${errors.join("; ")}`,
			"SCHEMA_VIOLATION",
			id,
		);
	}

	const routing = frontmatter.routing;
	const result: AgentCapability = {
		id,
		handles: routing?.handles ?? [],
		priority: routing?.priority ?? 0,
	};
	if (routing?.min_tier !== undefined) {
		result.min_tier = routing.min_tier;
	}
	return result;
}
