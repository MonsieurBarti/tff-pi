import type { Phase, Tier } from "./types.js";

export const TFF_CHANNELS = [
	"tff:phase",
	"tff:task",
	"tff:wave",
	"tff:review",
	"tff:pipeline",
	"tff:tool",
] as const;

export type TffChannel = (typeof TFF_CHANNELS)[number];

export interface TffEvent {
	timestamp: string;
	sliceId: string;
	sliceLabel: string;
	milestoneNumber: number;
}

export interface PhaseEvent extends TffEvent {
	type: "phase_start" | "phase_complete" | "phase_failed" | "phase_retried";
	phase: Phase;
	durationMs?: number;
	error?: string;
	feedback?: string;
	tier?: Tier;
}

export interface TaskEvent extends TffEvent {
	type: "task_dispatched" | "task_completed" | "task_failed" | "task_retried";
	taskId: string;
	taskTitle: string;
	wave: number;
	attempt?: number;
	durationMs?: number;
	error?: string;
}

export interface WaveEvent extends TffEvent {
	type: "wave_started" | "wave_completed";
	wave: number;
	totalWaves: number;
	taskCount: number;
	durationMs?: number;
}

export interface ReviewEvent extends TffEvent {
	type: "review_verdict";
	reviewer: "code" | "security";
	verdict: "approved" | "denied";
	findingCount: number;
	summary: string;
	tasksToRework?: string[];
}

export interface PipelineEvent extends TffEvent {
	type: "pipeline_start" | "pipeline_complete" | "pipeline_paused";
	fromPhase?: Phase;
	toPhase?: Phase;
	totalDurationMs?: number;
}

export interface ToolCallEvent {
	timestamp: string;
	type: "tool_call";
	// Slice context — null for ambient (between-phase) calls
	sliceId: string | null;
	sliceLabel: string | null;
	milestoneNumber: number | null;
	phase: Phase | null;
	// Tool identification
	toolCallId: string;
	toolName: string;
	// Payload
	input: unknown;
	output: unknown;
	isError: boolean;
	durationMs: number;
	startedAt: string;
}

export type TffEventMap = {
	"tff:phase": PhaseEvent;
	"tff:task": TaskEvent;
	"tff:wave": WaveEvent;
	"tff:review": ReviewEvent;
	"tff:pipeline": PipelineEvent;
	"tff:tool": ToolCallEvent;
};

export interface EventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export function makeBaseEvent(
	sliceId: string,
	sliceLabel: string,
	milestoneNumber: number,
): TffEvent {
	return {
		timestamp: new Date().toISOString(),
		sliceId,
		sliceLabel,
		milestoneNumber,
	};
}
