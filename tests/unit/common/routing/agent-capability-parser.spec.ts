import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AgentCapabilityParseError,
	parseAgentCapability,
} from "../../../../src/common/routing/agent-capability-parser.js";

const FIXTURE_ROOT = join(process.cwd(), "tests/fixtures/routing/agents");
const AGENT_ROOT = join(process.cwd(), "src/resources/agents");
const fixture = (name: string): string => readFileSync(join(FIXTURE_ROOT, `${name}.md`), "utf8");
const agentFile = (name: string): string => readFileSync(join(AGENT_ROOT, `${name}.md`), "utf8");

describe("parseAgentCapability", () => {
	it("AC-03: full routing block w/ min_tier hydrates correctly", () => {
		const cap = parseAgentCapability(fixture("valid-full"), "tff-x");
		expect(cap).toEqual({
			id: "tff-x",
			handles: ["foo", "bar"],
			priority: 5,
			min_tier: "sonnet",
		});
	});

	it("AC-04: routing without min_tier yields no min_tier key in result", () => {
		const cap = parseAgentCapability(fixture("valid-no-min-tier"), "tff-x");
		expect(cap).toEqual({ id: "tff-x", handles: ["foo"], priority: 3 });
		expect("min_tier" in cap).toBe(false);
	});

	it("AC-05: missing routing block returns additive defaults", () => {
		const cap = parseAgentCapability(fixture("missing-routing"), "tff-x");
		expect(cap).toEqual({ id: "tff-x", handles: [], priority: 0 });
	});

	it("AC-06: INVALID_ID on uppercase id", () => {
		try {
			parseAgentCapability(fixture("valid-full"), "Bad-ID");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentCapabilityParseError);
			expect((err as AgentCapabilityParseError).code).toBe("INVALID_ID");
		}
	});

	it("AC-06: TOO_LARGE on >1MB text", () => {
		const big = `---\nname: x\n---\n${"x".repeat(1024 * 1024 + 1)}`;
		try {
			parseAgentCapability(big, "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentCapabilityParseError);
			expect((err as AgentCapabilityParseError).code).toBe("TOO_LARGE");
		}
	});

	it("AC-06: NO_FRONTMATTER on body-only text", () => {
		try {
			parseAgentCapability(fixture("no-frontmatter"), "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect((err as AgentCapabilityParseError).code).toBe("NO_FRONTMATTER");
		}
	});

	it("AC-06: YAML_PARSE_ERROR on malformed yaml", () => {
		try {
			parseAgentCapability(fixture("malformed-yaml"), "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect((err as AgentCapabilityParseError).code).toBe("YAML_PARSE_ERROR");
		}
	});

	it("AC-06: SCHEMA_VIOLATION on bad min_tier", () => {
		try {
			parseAgentCapability(fixture("routing-bad-min-tier"), "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect((err as AgentCapabilityParseError).code).toBe("SCHEMA_VIOLATION");
		}
	});

	it("AC-06: SCHEMA_VIOLATION on bad priority", () => {
		try {
			parseAgentCapability(fixture("routing-bad-priority"), "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect((err as AgentCapabilityParseError).code).toBe("SCHEMA_VIOLATION");
		}
	});

	it("AC-09: agentId field populated on throw", () => {
		try {
			parseAgentCapability(fixture("routing-bad-priority"), "tff-x");
			expect.fail("should have thrown");
		} catch (err) {
			expect((err as AgentCapabilityParseError).agentId).toBe("tff-x");
		}
	});

	it("AC-07: tff-executor parses with handles=[], priority=0, no min_tier", () => {
		const cap = parseAgentCapability(agentFile("tff-executor"), "tff-executor");
		expect(cap).toEqual({ id: "tff-executor", handles: [], priority: 0 });
		expect("min_tier" in cap).toBe(false);
	});

	it("AC-07: tff-fixer parses with handles=[], priority=0, no min_tier", () => {
		const cap = parseAgentCapability(agentFile("tff-fixer"), "tff-fixer");
		expect(cap).toEqual({ id: "tff-fixer", handles: [], priority: 0 });
	});

	it("AC-07: tff-verifier parses with handles=[], priority=0, no min_tier", () => {
		const cap = parseAgentCapability(agentFile("tff-verifier"), "tff-verifier");
		expect(cap).toEqual({ id: "tff-verifier", handles: [], priority: 0 });
	});

	it("AC-07: tff-code-reviewer parses with mirrored tff-cc handles", () => {
		const cap = parseAgentCapability(agentFile("tff-code-reviewer"), "tff-code-reviewer");
		expect(cap).toEqual({
			id: "tff-code-reviewer",
			handles: ["standard_review", "code_quality"],
			priority: 10,
		});
		expect("min_tier" in cap).toBe(false);
	});

	it("AC-07: tff-security-auditor parses with full risk-tag handles", () => {
		const cap = parseAgentCapability(agentFile("tff-security-auditor"), "tff-security-auditor");
		expect(cap).toEqual({
			id: "tff-security-auditor",
			handles: ["high_risk", "auth", "migrations", "pii", "secret", "breaking"],
			priority: 20,
		});
		expect("min_tier" in cap).toBe(false);
	});
});
