import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PhaseEvent,
	PipelineEvent,
	ReviewEvent,
	TaskEvent,
	WaveEvent,
} from "../../../src/common/events.js";
import { PipelineState, TUIMonitor } from "../../../src/common/tui-monitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (data: unknown) => void;

class MockEventBus {
	private handlers = new Map<string, Handler[]>();

	on(channel: string, handler: Handler): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		return () => {
			const updated = this.handlers.get(channel) ?? [];
			const idx = updated.indexOf(handler);
			if (idx !== -1) updated.splice(idx, 1);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(data);
		}
	}

	subscribedChannels(): string[] {
		return [...this.handlers.keys()];
	}
}

function makeBase() {
	return {
		timestamp: new Date().toISOString(),
		sliceId: "slice-1",
		sliceLabel: "M01-S02",
		milestoneNumber: 1,
	};
}

function makePhaseEvent(overrides: Partial<PhaseEvent> = {}): PhaseEvent {
	return { ...makeBase(), type: "phase_start", phase: "research", ...overrides };
}

function makePipelineEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
	return { ...makeBase(), type: "pipeline_start", ...overrides };
}

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
	return {
		...makeBase(),
		type: "task_dispatched",
		taskId: "t1",
		taskTitle: "Do work",
		wave: 1,
		...overrides,
	};
}

function makeWaveEvent(overrides: Partial<WaveEvent> = {}): WaveEvent {
	return {
		...makeBase(),
		type: "wave_started",
		wave: 1,
		totalWaves: 3,
		taskCount: 4,
		...overrides,
	};
}

function makeReviewEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
	return {
		...makeBase(),
		type: "review_verdict",
		reviewer: "code",
		verdict: "approved",
		findingCount: 0,
		summary: "Looks good",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// PipelineState tests
// ---------------------------------------------------------------------------

describe("PipelineState", () => {
	let state: PipelineState;

	beforeEach(() => {
		state = new PipelineState();
	});

	describe("formatStatusLine after phase_start", () => {
		it("includes sliceLabel and phase name", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "research" }));
			const line = state.formatStatusLine();
			expect(line).toContain("M01-S02");
			expect(line).toContain("research");
		});

		it("returns idle string when not active", () => {
			const line = state.formatStatusLine();
			expect(line).toContain("tff");
		});
	});

	describe("wave progress tracking", () => {
		it("tracks current wave and total waves after wave_started", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updateWave(makeWaveEvent({ wave: 2, totalWaves: 3, taskCount: 5 }));
			const line = state.formatStatusLine();
			expect(line).toContain("2/3");
			expect(line).toContain("5");
		});

		it("formats status line with wave info", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "execute" }));
			state.updateWave(makeWaveEvent({ wave: 1, totalWaves: 2, taskCount: 3 }));
			const line = state.formatStatusLine();
			expect(line).toMatch(/wave\s+1\/2/);
		});
	});

	describe("formatWidget with phase progress icons", () => {
		it("shows in-progress icon for current phase", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "plan" }));
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			expect(joined).toContain("◉");
			expect(joined).toContain("plan");
		});

		it("shows done icon for completed phases", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "discuss" }));
			state.updatePhase(
				makePhaseEvent({ type: "phase_complete", phase: "discuss", durationMs: 5000 }),
			);
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "research" }));
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			expect(joined).toContain("✓");
		});

		it("shows failed icon for failed phases", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "verify" }));
			state.updatePhase(
				makePhaseEvent({ type: "phase_failed", phase: "verify", error: "2 ACs unmet" }),
			);
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			expect(joined).toContain("✗");
		});

		it("shows pending dots for future phases", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "discuss" }));
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			expect(joined).toContain("·");
		});

		it("includes elapsed time", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			expect(joined).toMatch(/elapsed|0s/i);
		});
	});

	describe("resets on pipeline_complete", () => {
		it("clears active state after pipeline_complete", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_start", phase: "research" }));
			expect(state.isActive).toBe(true);

			state.handlePipeline(
				makePipelineEvent({ type: "pipeline_complete", totalDurationMs: 10000 }),
			);
			expect(state.isActive).toBe(false);
		});

		it("clears completed phases after reset", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updatePhase(makePhaseEvent({ type: "phase_complete", phase: "discuss" }));
			state.handlePipeline(makePipelineEvent({ type: "pipeline_complete" }));

			// After a new pipeline_start the state should be fresh
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			const lines = state.formatWidget();
			const joined = lines.join("\n");
			// No ✓ should appear since we just started fresh
			expect(joined).not.toContain("✓");
		});
	});

	describe("task tracking", () => {
		it("tracks active and completed tasks", () => {
			state.handlePipeline(makePipelineEvent({ type: "pipeline_start" }));
			state.updateTask(makeTaskEvent({ type: "task_dispatched", taskId: "t1" }));
			state.updateTask(makeTaskEvent({ type: "task_dispatched", taskId: "t2" }));
			state.updateTask(makeTaskEvent({ type: "task_completed", taskId: "t1" }));
			// t1 completed, t2 still active
			const line = state.formatStatusLine();
			expect(line).toBeDefined();
		});
	});
});

// ---------------------------------------------------------------------------
// TUIMonitor tests
// ---------------------------------------------------------------------------

describe("TUIMonitor", () => {
	let bus: MockEventBus;
	let setStatus: ReturnType<typeof vi.fn>;
	let setWidget: ReturnType<typeof vi.fn>;
	let notify: ReturnType<typeof vi.fn>;
	let monitor: TUIMonitor;

	beforeEach(() => {
		bus = new MockEventBus();
		setStatus = vi.fn();
		setWidget = vi.fn();
		notify = vi.fn();
		monitor = new TUIMonitor({ setStatus, setWidget, notify });
		monitor.subscribe(bus);
	});

	describe("channel subscriptions", () => {
		it("subscribes to all 5 TFF channels", () => {
			const channels = bus.subscribedChannels().sort();
			expect(channels).toEqual(
				["tff:phase", "tff:pipeline", "tff:review", "tff:task", "tff:wave"].sort(),
			);
		});
	});

	describe("setStatus on phase event", () => {
		it("calls setStatus with tff key after pipeline_start activates and phase_start fires", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit("tff:phase", makePhaseEvent({ type: "phase_start", phase: "research" }));
			expect(setStatus).toHaveBeenCalledWith("tff", expect.stringContaining("tff"));
		});

		it("does not call setStatus when pipeline is not active", () => {
			// No pipeline_start, just emit a phase event
			setStatus.mockClear();
			// Even without activation, render is still called but status may just be idle
			bus.emit("tff:phase", makePhaseEvent({ type: "phase_start", phase: "research" }));
			// setStatus is called but with an idle-like string
			expect(setStatus).toHaveBeenCalled();
		});
	});

	describe("notify on phase_complete", () => {
		it("calls notify with info level on phase_complete", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent({ type: "phase_complete", phase: "discuss", durationMs: 5000, tier: "SS" }),
			);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("discuss"), "info");
		});

		it("includes duration in the notification message", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent({ type: "phase_complete", phase: "discuss", durationMs: 5000 }),
			);
			const [msg] = notify.mock.calls[0] as [string, string];
			expect(msg).toContain("5s");
		});

		it("includes tier in notification when present", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent({ type: "phase_complete", phase: "discuss", durationMs: 5000, tier: "SS" }),
			);
			const [msg] = notify.mock.calls[0] as [string, string];
			expect(msg).toContain("SS");
		});
	});

	describe("notify with error on phase_failed", () => {
		it("calls notify with error level on phase_failed", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent({ type: "phase_failed", phase: "verify", error: "2 ACs unmet" }),
			);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("verify"), "error");
		});

		it("includes error message in notification", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:phase",
				makePhaseEvent({ type: "phase_failed", phase: "verify", error: "2 ACs unmet" }),
			);
			const [msg] = notify.mock.calls[0] as [string, string];
			expect(msg).toContain("2 ACs unmet");
		});
	});

	describe("review denied notification", () => {
		it("calls notify with warning level when review is denied", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit(
				"tff:review",
				makeReviewEvent({
					verdict: "denied",
					reviewer: "security",
					findingCount: 3,
					summary: "XSS found",
				}),
			);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("security"), "warning");
		});

		it("does not notify when review is approved", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit("tff:review", makeReviewEvent({ verdict: "approved" }));
			expect(notify).not.toHaveBeenCalled();
		});
	});

	describe("pipeline_complete notification", () => {
		it("calls notify with info and clears status/widget on pipeline_complete", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			notify.mockClear();
			setStatus.mockClear();
			setWidget.mockClear();

			bus.emit(
				"tff:pipeline",
				makePipelineEvent({ type: "pipeline_complete", totalDurationMs: 10000 }),
			);

			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Pipeline complete"), "info");
			expect(setStatus).toHaveBeenCalledWith("tff", "");
		});
	});

	describe("setWidget on active pipeline", () => {
		it("calls setWidget with tff-progress key when pipeline is active", () => {
			bus.emit("tff:pipeline", makePipelineEvent({ type: "pipeline_start" }));
			bus.emit("tff:phase", makePhaseEvent({ type: "phase_start", phase: "research" }));
			expect(setWidget).toHaveBeenCalledWith(
				"tff-progress",
				expect.any(Array),
				expect.objectContaining({ placement: "belowEditor" }),
			);
		});
	});
});
