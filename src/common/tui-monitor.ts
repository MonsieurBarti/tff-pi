import type { Phase } from "../orchestrator.js";
import { TFF_CHANNELS } from "./events.js";
import type { PhaseEvent, PipelineEvent, ReviewEvent, TaskEvent, WaveEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Interfaces (no PI imports)
// ---------------------------------------------------------------------------

interface EventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface UIContext {
	setStatus(key: string, text: string): void;
	setWidget(key: string, content: string[], options?: Record<string, unknown>): void;
	notify?(msg: string, level?: string): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_PHASES: Phase[] = ["discuss", "research", "plan", "execute", "verify", "review", "ship"];

function phaseIcon(
	phase: Phase,
	current: Phase | null,
	completed: Set<Phase>,
	failed: Set<Phase>,
): string {
	if (failed.has(phase)) return "✗";
	if (completed.has(phase)) return "✓";
	if (phase === current) return "◉";
	return "·";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return "0s";
	return `${Math.round(ms / 1000)}s`;
}

function elapsedMs(start: Date): number {
	return Date.now() - start.getTime();
}

// ---------------------------------------------------------------------------
// PipelineState
// ---------------------------------------------------------------------------

export class PipelineState {
	isActive = false;
	sliceLabel = "";
	currentPhase: Phase | null = null;
	completedPhases: Set<Phase> = new Set();
	failedPhases: Set<Phase> = new Set();
	currentWave: number | null = null;
	totalWaves: number | null = null;
	waveTaskCount: number | null = null;
	completedTasks: Set<string> = new Set();
	failedTasks: Set<string> = new Set();
	activeTasks: Set<string> = new Set();
	reviewVerdicts: Map<string, "approved" | "denied"> = new Map();
	startTime: Date | null = null;

	private reset(): void {
		this.isActive = false;
		this.sliceLabel = "";
		this.currentPhase = null;
		this.completedPhases = new Set();
		this.failedPhases = new Set();
		this.currentWave = null;
		this.totalWaves = null;
		this.waveTaskCount = null;
		this.completedTasks = new Set();
		this.failedTasks = new Set();
		this.activeTasks = new Set();
		this.reviewVerdicts = new Map();
		this.startTime = null;
	}

	updatePhase(event: PhaseEvent): void {
		if (event.sliceLabel && !this.sliceLabel) {
			this.sliceLabel = event.sliceLabel;
		}
		switch (event.type) {
			case "phase_start":
			case "phase_retried":
				this.currentPhase = event.phase;
				break;
			case "phase_complete":
				this.completedPhases.add(event.phase);
				if (this.currentPhase === event.phase) this.currentPhase = null;
				break;
			case "phase_failed":
				this.failedPhases.add(event.phase);
				if (this.currentPhase === event.phase) this.currentPhase = null;
				break;
		}
	}

	updateWave(event: WaveEvent): void {
		this.currentWave = event.wave;
		this.totalWaves = event.totalWaves;
		this.waveTaskCount = event.taskCount;
	}

	updateTask(event: TaskEvent): void {
		switch (event.type) {
			case "task_dispatched":
				this.activeTasks.add(event.taskId);
				break;
			case "task_completed":
				this.activeTasks.delete(event.taskId);
				this.completedTasks.add(event.taskId);
				break;
			case "task_failed":
				this.activeTasks.delete(event.taskId);
				this.failedTasks.add(event.taskId);
				break;
			case "task_retried":
				// keep in activeTasks
				break;
		}
	}

	updateReview(event: ReviewEvent): void {
		this.reviewVerdicts.set(event.reviewer, event.verdict);
	}

	handlePipeline(event: PipelineEvent): void {
		switch (event.type) {
			case "pipeline_start":
				this.reset();
				this.isActive = true;
				this.sliceLabel = event.sliceLabel;
				this.startTime = new Date(event.timestamp);
				break;
			case "pipeline_complete":
			case "pipeline_paused":
				this.isActive = false;
				break;
		}
	}

	formatStatusLine(): string {
		if (!this.isActive) return "tff: idle";

		const label = this.sliceLabel || "…";
		const parts: string[] = [`tff: ${label}`];

		if (this.currentPhase) {
			if (this.currentWave !== null && this.totalWaves !== null) {
				const tasks = this.waveTaskCount !== null ? ` (${this.waveTaskCount} tasks)` : "";
				parts.push(`── executing wave ${this.currentWave}/${this.totalWaves}${tasks}`);
			} else {
				parts.push(`── ${this.currentPhase}`);
			}
		} else if (this.currentWave !== null && this.totalWaves !== null) {
			const tasks = this.waveTaskCount !== null ? ` (${this.waveTaskCount} tasks)` : "";
			parts.push(`── wave ${this.currentWave}/${this.totalWaves}${tasks}`);
		}

		return parts.join(" ");
	}

	formatWidget(): string[] {
		const lines: string[] = [];

		// Phase progress line
		const phaseIcons = ALL_PHASES.map((p) => {
			const icon = phaseIcon(p, this.currentPhase, this.completedPhases, this.failedPhases);
			return `${icon} ${p}`;
		});
		lines.push(phaseIcons.join("  "));

		// Wave detail (if in execute phase with wave info)
		if (this.currentWave !== null && this.totalWaves !== null) {
			const done = this.completedTasks.size;
			const active = this.activeTasks.size;
			const total = this.waveTaskCount ?? done + active;
			lines.push(`  wave ${this.currentWave}/${this.totalWaves} — ${done}/${total} tasks complete`);
		}

		// Elapsed time
		const elapsed = this.startTime ? elapsedMs(this.startTime) : 0;
		lines.push(`  elapsed: ${formatDuration(elapsed)}`);

		return lines;
	}
}

// ---------------------------------------------------------------------------
// TUIMonitor
// ---------------------------------------------------------------------------

export class TUIMonitor {
	private state = new PipelineState();

	constructor(private ui: UIContext) {}

	subscribe(events: EventBus): void {
		events.on(TFF_CHANNELS[0], (data) => this.onPhase(data as PhaseEvent));
		events.on(TFF_CHANNELS[1], (data) => this.onTask(data as TaskEvent));
		events.on(TFF_CHANNELS[2], (data) => this.onWave(data as WaveEvent));
		events.on(TFF_CHANNELS[3], (data) => this.onReview(data as ReviewEvent));
		events.on(TFF_CHANNELS[4], (data) => this.onPipeline(data as PipelineEvent));
	}

	private onPhase(event: PhaseEvent): void {
		this.state.updatePhase(event);

		if (event.type === "phase_complete") {
			const dur = event.durationMs !== undefined ? `, ${formatDuration(event.durationMs)}` : "";
			const tier = event.tier ? `, tier: ${event.tier}` : "";
			this.ui.notify?.(`${event.phase} complete (${dur.replace(", ", "")}${tier})`, "info");
		} else if (event.type === "phase_failed") {
			const err = event.error ? `: ${event.error}` : "";
			this.ui.notify?.(`${event.phase} failed${err}`, "error");
		}

		this.render();
	}

	private onTask(event: TaskEvent): void {
		this.state.updateTask(event);
		this.render();
	}

	private onWave(event: WaveEvent): void {
		this.state.updateWave(event);
		this.render();
	}

	private onReview(event: ReviewEvent): void {
		this.state.updateReview(event);

		if (event.verdict === "denied") {
			this.ui.notify?.(
				`${event.reviewer} reviewer denied: ${event.findingCount} findings`,
				"warning",
			);
		}

		this.render();
	}

	private onPipeline(event: PipelineEvent): void {
		this.state.handlePipeline(event);

		if (event.type === "pipeline_complete") {
			const dur =
				event.totalDurationMs !== undefined ? ` (${formatDuration(event.totalDurationMs)})` : "";
			this.ui.notify?.(`Pipeline complete${dur}`, "info");
			this.ui.setStatus("tff", "");
			this.ui.setWidget?.("tff-progress", []);
			return;
		}

		if (event.type === "pipeline_paused") {
			this.ui.setStatus("tff", "");
			this.ui.setWidget?.("tff-progress", []);
			return;
		}

		if (this.state.isActive) {
			this.render();
		}
	}

	private render(): void {
		const statusLine = this.state.formatStatusLine();
		this.ui.setStatus("tff", statusLine);

		if (this.state.isActive) {
			const widgetLines = this.state.formatWidget();
			this.ui.setWidget("tff-progress", widgetLines, { placement: "belowEditor" });
		}
	}
}
