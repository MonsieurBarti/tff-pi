export const SLICE_STATUSES = [
	"created",
	"discussing",
	"researching",
	"planning",
	"executing",
	"verifying",
	"reviewing",
	"shipping",
	"closed",
] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export const MILESTONE_STATUSES = ["created", "in_progress", "completing", "closed"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const TASK_STATUSES = ["open", "in_progress", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TIERS = ["S", "SS", "SSS"] as const;
export type Tier = (typeof TIERS)[number];

export type Phase = "discuss" | "research" | "plan" | "execute" | "verify" | "review" | "ship";
export const ALL_PHASES: Phase[] = [
	"discuss",
	"research",
	"plan",
	"execute",
	"verify",
	"review",
	"ship",
];

export interface Project {
	id: string;
	name: string;
	vision: string;
	createdAt: string;
}

export interface Milestone {
	id: string;
	projectId: string;
	number: number;
	name: string;
	status: MilestoneStatus;
	branch: string;
	createdAt: string;
}

export interface Slice {
	id: string;
	milestoneId: string;
	number: number;
	title: string;
	status: SliceStatus;
	tier: Tier | null;
	prUrl: string | null;
	createdAt: string;
}

export interface Task {
	id: string;
	sliceId: string;
	number: number;
	title: string;
	status: TaskStatus;
	wave: number | null;
	claimedBy: string | null;
	createdAt: string;
}

export interface Dependency {
	fromTaskId: string;
	toTaskId: string;
}

export function milestoneLabel(number: number): string {
	return `M${String(number).padStart(2, "0")}`;
}

export function sliceLabel(milestoneNumber: number, sliceNumber: number): string {
	return `${milestoneLabel(milestoneNumber)}-S${String(sliceNumber).padStart(2, "0")}`;
}

export function taskLabel(taskNumber: number): string {
	return `T${String(taskNumber).padStart(2, "0")}`;
}

/** Real-time activity from the child pi process. */
export interface SubAgentActivity {
	/** Current tool being executed (null when between tools). */
	currentTool: string | null;
	/** Args of the current tool call. */
	currentToolArgs: Record<string, unknown> | null;
	/** Completed tool calls so far. */
	completedTools: string[];
	/** Number of LLM turns completed. */
	turns: number;
	/** Elapsed time in ms since spawn. */
	elapsedMs: number;
}

export interface ValidateResult {
	valid: boolean;
	error?: string;
}

export function sanitizeForPrompt(input: string): string {
	// Strip markdown code fence boundaries that could escape prompt context
	// Strip system/assistant/user role markers that could manipulate LLM behavior
	return input.replace(/```/g, "'''").replace(/^(system|assistant|user):/gim, "$1 -");
}
