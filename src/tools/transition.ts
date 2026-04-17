import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice, insertPhaseRun } from "../common/db.js";
import { expectedInProgressStatusFor } from "../common/derived-state.js";
import { appendCommand, updateLogCursor } from "../common/event-log.js";
import { makeBaseEvent } from "../common/events.js";
import { projectCommand } from "../common/projection.js";
import { SLICE_TRANSITIONS, canTransitionSlice, nextSliceStatus } from "../common/state-machine.js";
import { type Phase, SLICE_STATUSES, type SliceStatus, sliceLabel } from "../common/types.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

const STATUS_TO_PHASE: Partial<Record<SliceStatus, Phase>> = {
	discussing: "discuss",
	researching: "research",
	planning: "plan",
	executing: "execute",
	verifying: "verify",
	reviewing: "review",
	shipping: "ship",
};

export function handleTransition(
	pi: ExtensionAPI,
	db: Database.Database,
	sliceId: string,
	milestoneNumber: number,
	targetStatus?: string,
	root?: string,
): ToolResult {
	if (!root) {
		return {
			content: [
				{
					type: "text",
					text: "Cannot transition: no project root available. Ensure /tff init has been run.",
				},
			],
			details: { sliceId },
			isError: true,
		};
	}

	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}

	if (targetStatus && !(SLICE_STATUSES as readonly string[]).includes(targetStatus)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid status: ${targetStatus}. Valid: ${SLICE_STATUSES.join(", ")}`,
				},
			],
			details: { sliceId, targetStatus },
			isError: true,
		};
	}

	const target = targetStatus
		? (targetStatus as SliceStatus)
		: nextSliceStatus(slice.status, slice.tier ?? undefined);

	if (!target) {
		return {
			content: [{ type: "text", text: `No valid next status from '${slice.status}'.` }],
			details: { sliceId, currentStatus: slice.status },
			isError: true,
		};
	}

	if (target === "closed") {
		return {
			content: [
				{
					type: "text",
					text: "Cannot transition directly to 'closed'. Run /tff ship to merge the PR; the slice will close automatically once the merge evidence is present.",
				},
			],
			details: { sliceId, from: slice.status, to: target },
			isError: true,
		};
	}

	if (!canTransitionSlice(slice.status, target)) {
		return {
			content: [
				{
					type: "text",
					text: `Invalid transition: '${slice.status}' → '${target}'. Allowed from '${slice.status}': ${SLICE_TRANSITIONS[slice.status].join(", ")}`,
				},
			],
			details: { sliceId, from: slice.status, to: target },
			isError: true,
		};
	}

	const phaseForTarget = STATUS_TO_PHASE[target];
	if (!phaseForTarget) {
		return {
			content: [
				{
					type: "text",
					text: `Cannot transition to '${target}' via this tool.`,
				},
			],
			details: { sliceId, from: slice.status, to: target },
			isError: true,
		};
	}

	const sLabel = sliceLabel(milestoneNumber, slice.number);

	// Block 3: atomic state mutation + event-log append in one transaction.
	// projectCommand("transition") does UPDATE slice SET status — no reconcile.
	// This asymmetry is load-bearing: transition is the authoritative override.
	db.transaction(() => {
		projectCommand(db, root, "transition", { sliceId: slice.id, from: slice.status, to: target });
		const { hash, row } = appendCommand(root, "transition", {
			sliceId: slice.id,
			from: slice.status,
			to: target,
		});
		updateLogCursor(db, hash, row);
	})();

	// Post-commit: insert a phase_run row for the new phase lifecycle.
	// This is independent of the transition command itself.
	const now = new Date().toISOString();
	insertPhaseRun(db, {
		sliceId,
		phase: phaseForTarget,
		status: "started",
		startedAt: now,
	});

	// Post-commit bus emit for TUIMonitor subscribers (write-only; no DB side-effects).
	pi.events.emit("tff:phase", {
		...makeBaseEvent(sliceId, sLabel, milestoneNumber),
		type: "phase_start",
		phase: phaseForTarget,
	});

	// Sanity-check: re-fetch slice to confirm the status persisted.
	const expected = expectedInProgressStatusFor(phaseForTarget);
	const after = getSlice(db, sliceId);
	if (!after || (expected !== null && after.status !== expected)) {
		const actual = after?.status ?? "<missing>";
		return {
			content: [
				{
					type: "text",
					text: `Transition command written for ${sliceId} (${slice.status} → ${target}) but slice.status is "${actual}". The transaction may have rolled back — check .tff/event-log.jsonl (or stderr if the write itself failed) for details. Recovery: inspect the logged error, fix the root cause, and re-run the transition.`,
				},
			],
			details: {
				sliceId,
				from: slice.status,
				expected,
				actual,
				phaseEmitted: phaseForTarget,
				persistenceVerified: false,
			},
			isError: true,
		};
	}

	return {
		content: [
			{
				type: "text",
				text: `Slice ${sliceId} transitioned: ${slice.status} → ${target}`,
			},
		],
		details: {
			sliceId,
			from: slice.status,
			to: target,
			phaseEmitted: phaseForTarget,
			persistenceVerified: true,
		},
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_transition",
			label: "TFF Transition Slice",
			description:
				"Transition a slice to a new status. Validates the transition is allowed by the state machine. If targetStatus is omitted, advances to the next status. IMPORTANT: Only call this tool when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptSnippet:
				"IMPORTANT: Only call tff_transition when the user explicitly asks to advance phases. Never transition on your own initiative after a tool call.",
			promptGuidelines: [
				"Do NOT call tff_transition automatically after writing specs or plans",
				"Always ask the user before transitioning to the next phase",
				"Users advance phases explicitly with the specific phase command (e.g., /tff plan M01-S01).",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				targetStatus: Type.Optional(
					StringEnum([...SLICE_STATUSES], {
						description:
							"The target status to transition to. If omitted, advances to the next logical status.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) {
						return {
							content: [{ type: "text", text: `Milestone not found for slice: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}
					return handleTransition(
						pi,
						database,
						slice.id,
						milestone.number,
						params.targetStatus,
						ctx.projectRoot ?? undefined,
					);
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
