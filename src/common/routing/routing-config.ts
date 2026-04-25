import { readFile } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseYaml } from "yaml";
import { tffPath } from "../artifacts.js";
import { ModelTierSchema } from "./agent-capability.js";
import { errnoCode } from "./fs-helpers.js";
import type { TierPolicy } from "./tier-resolver.js";

const TierPolicySchema = Type.Object({
	low: ModelTierSchema,
	medium: ModelTierSchema,
	high: ModelTierSchema,
});

// Explicit object form, NOT Type.Record. Reasons:
//   1. Type.Record(literalUnion, …) marks every key required (verified empirically against TypeBox 0.34),
//      which would reject the common `{ review: [...] }` partial override.
//   2. Type.Record does not enforce additionalProperties:false, so mistyped keys like `reveiw`
//      slip through schema validation.
// Type.Object with all-optional members + additionalProperties:false fixes both.
const PoolsSchema = Type.Object(
	{
		execute: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		verify: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		review: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);

export const RoutingConfigSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		confidence_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		tier_policy: Type.Optional(TierPolicySchema),
		pools: Type.Optional(PoolsSchema),
	},
	{ additionalProperties: true },
);

const SettingsEnvelopeSchema = Type.Object(
	{ routing: Type.Optional(Type.Unknown()) },
	{ additionalProperties: true },
);

export interface RoutingConfig {
	enabled: boolean;
	confidence_threshold: number;
	tier_policy: TierPolicy | undefined;
	pools: Partial<Record<"execute" | "verify" | "review", string[]>>;
}

const DEFAULTS: RoutingConfig = {
	enabled: false,
	confidence_threshold: 0,
	tier_policy: undefined,
	pools: {},
};

export class RoutingConfigParseError extends Error {
	constructor(
		message: string,
		public readonly code: "YAML_PARSE_ERROR" | "SCHEMA_VIOLATION",
	) {
		super(message);
		this.name = "RoutingConfigParseError";
	}
}

export async function loadRoutingConfig(root: string): Promise<RoutingConfig> {
	const path = tffPath(root, "settings.yaml");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if (errnoCode(e) === "ENOENT") return { ...DEFAULTS };
		throw e;
	}
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch {
		throw new RoutingConfigParseError("settings.yaml: yaml parse error", "YAML_PARSE_ERROR");
	}
	if (!Value.Check(SettingsEnvelopeSchema, doc)) return { ...DEFAULTS };
	const routing = doc.routing;
	if (routing === undefined) return { ...DEFAULTS };
	if (!Value.Check(RoutingConfigSchema, routing)) {
		const errs = [...Value.Errors(RoutingConfigSchema, routing)].map(
			(e) => `${e.path}: ${e.message}`,
		);
		throw new RoutingConfigParseError(
			`settings.yaml routing.*: ${errs.join("; ")}`,
			"SCHEMA_VIOLATION",
		);
	}
	const r: Static<typeof RoutingConfigSchema> = routing;
	return {
		enabled: r.enabled ?? DEFAULTS.enabled,
		confidence_threshold: r.confidence_threshold ?? DEFAULTS.confidence_threshold,
		tier_policy: r.tier_policy,
		pools: r.pools ?? {},
	};
}
