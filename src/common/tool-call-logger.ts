import { getCurrentPhase } from "./current-phase-context.js";
import type { EventBus, ToolCallEvent } from "./events.js";

/**
 * Tools whose effects matter for audit (R14) and forensics (R15).
 * Narrow by design. Widen only if Slice 2 proves it needs more.
 */
const ALLOW_LIST = new Set(["bash", "write", "edit", "notebook_edit"]);
const ALLOW_PREFIXES = ["tff_write_", "tff_classify"];

/** Stale entries are evicted if tool_execution_end never fires. */
const STALE_PENDING_MS = 5 * 60 * 1000;

interface Pending {
	input: unknown;
	startedAt: string;
	startedAtMs: number;
}

type PiHandler = (event: unknown, ctx?: unknown) => unknown;

/**
 * Minimal structural subset of ExtensionAPI used here. Full type import is
 * avoided so unit tests can feed a tiny fake without constructing the whole
 * ExtensionAPI surface.
 */
export interface ToolCallLoggerPi {
	on(event: string, handler: PiHandler): () => void;
}

function shouldCapture(toolName: string): boolean {
	if (ALLOW_LIST.has(toolName)) return true;
	return ALLOW_PREFIXES.some((p) => toolName.startsWith(p));
}

export class ToolCallLogger {
	private pending = new Map<string, Pending>();
	private unsubscribers: Array<() => void> = [];

	constructor(
		private pi: ToolCallLoggerPi,
		private events: EventBus,
	) {}

	subscribe(): void {
		const unsubCall = this.pi.on("tool_call", (raw) => {
			try {
				const event = raw as { toolCallId?: string; toolName?: string; input?: unknown };
				if (!event.toolCallId || !event.toolName) return;
				if (!shouldCapture(event.toolName)) return;
				const now = Date.now();
				this.pending.set(event.toolCallId, {
					input: event.input,
					startedAt: new Date(now).toISOString(),
					startedAtMs: now,
				});
				this.gcStale();
			} catch {
				// Monitoring must not fail the pipeline.
			}
		});
		const unsubEnd = this.pi.on("tool_execution_end", (raw) => {
			try {
				const event = raw as {
					toolCallId?: string;
					toolName?: string;
					result?: unknown;
					isError?: boolean;
				};
				if (!event.toolCallId || !event.toolName) return;
				const pending = this.pending.get(event.toolCallId);
				if (!pending) return;
				this.pending.delete(event.toolCallId);

				const endMs = Date.now();
				const phase = getCurrentPhase();
				const out: ToolCallEvent = {
					timestamp: new Date(endMs).toISOString(),
					type: "tool_call",
					sliceId: phase?.sliceId ?? null,
					sliceLabel: phase?.sliceLabel ?? null,
					milestoneNumber: phase?.milestoneNumber ?? null,
					phase: phase?.phase ?? null,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: pending.input,
					output: event.result,
					isError: !!event.isError,
					durationMs: endMs - pending.startedAtMs,
					startedAt: pending.startedAt,
				};
				this.events.emit("tff:tool", out);
			} catch {
				// Monitoring must not fail the pipeline.
			}
		});
		this.unsubscribers.push(unsubCall, unsubEnd);
	}

	dispose(): void {
		for (const u of this.unsubscribers) u();
		this.unsubscribers = [];
		this.pending.clear();
	}

	private gcStale(): void {
		const cutoff = Date.now() - STALE_PENDING_MS;
		for (const [id, p] of this.pending) {
			if (p.startedAtMs < cutoff) this.pending.delete(id);
		}
	}
}
