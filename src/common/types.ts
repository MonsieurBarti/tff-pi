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
	"paused",
] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export const MILESTONE_STATUSES = ["created", "in_progress", "completing", "closed"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const TASK_STATUSES = ["open", "in_progress", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TIERS = ["S", "SS", "SSS"] as const;
export type Tier = (typeof TIERS)[number];

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

export interface ValidateResult {
	valid: boolean;
	error?: string;
}
