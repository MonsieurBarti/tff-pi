import { type Static, Type } from "@sinclair/typebox";

export const ModelTierSchema = Type.Union([
	Type.Literal("haiku"),
	Type.Literal("sonnet"),
	Type.Literal("opus"),
]);
export type ModelTier = Static<typeof ModelTierSchema>;

export const TIER_ORDER: Record<ModelTier, number> = {
	haiku: 0,
	sonnet: 1,
	opus: 2,
};

export const AgentCapabilitySchema = Type.Object({
	id: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
	handles: Type.Array(Type.String()),
	priority: Type.Integer(),
	min_tier: Type.Optional(ModelTierSchema),
});
export type AgentCapability = Static<typeof AgentCapabilitySchema>;
