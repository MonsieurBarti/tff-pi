import { type Static, Type } from "@sinclair/typebox";

export const ComplexityLevelSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);
export type ComplexityLevel = Static<typeof ComplexityLevelSchema>;

export const RiskLevelSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);
export type RiskLevel = Static<typeof RiskLevelSchema>;

export const RiskSchema = Type.Object({
	level: RiskLevelSchema,
	tags: Type.Array(Type.String()),
});
export type Risk = Static<typeof RiskSchema>;

export const SignalsSchema = Type.Object({
	complexity: ComplexityLevelSchema,
	risk: RiskSchema,
});
export type Signals = Static<typeof SignalsSchema>;
