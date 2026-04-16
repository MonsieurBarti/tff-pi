import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

export type LogComponent =
	| "event-log"
	| "event-logger"
	| "projection"
	| "commit"
	| "logger"
	| "tool"
	| "transition"
	| "phase"
	| "completion"
	| "derived"
	| "reconcile"
	| "db"
	| "session"
	| "artifact"
	| "state-branch"
	| "snapshot"
	| "doctor"
	| "recover"
	| "ship"
	| "command"
	| "lifecycle";

export interface LogContext {
	fn?: string;
	tool?: string;
	mid?: string;
	sid?: string;
	tid?: string;
	worktree?: string;
	id?: string;
	error?: string;
	count?: number;
	stack?: string;
	step?: string;
	stderr?: string;
}

const ALLOWLIST: ReadonlyArray<keyof LogContext> = [
	"fn",
	"tool",
	"mid",
	"sid",
	"tid",
	"worktree",
	"id",
	"error",
	"count",
	"stack",
	"step",
	"stderr",
];

export interface AuditLogLine {
	level: "error";
	ts: string;
	component: LogComponent;
	message: string;
	session_id: string;
	ctx: LogContext;
}

let basePath: string | null = null;
let sessionId: string | null = null;
let stderrEnabled = true;
let suppressRecursion = false;

export function setLogBasePath(root: string): void {
	basePath = root;
	if (sessionId === null) sessionId = randomUUID();
}

export function setStderrLoggingEnabled(enabled: boolean): void {
	stderrEnabled = enabled;
}

export function getSessionId(): string {
	if (sessionId === null) sessionId = randomUUID();
	return sessionId;
}

function sanitize(ctx: LogContext | undefined): LogContext {
	if (!ctx) return {};
	const out: LogContext = {};
	for (const key of ALLOWLIST) {
		const val = ctx[key];
		if (val === undefined) continue;
		if (key === "error" && typeof val !== "string") {
			out.error = String(val);
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: allowlist-guarded assignment of known-keyof value
			(out as any)[key] = val;
		}
	}
	return out;
}

interface Envelope {
	level: "warn" | "error";
	ts: string;
	component: LogComponent;
	message: string;
	session_id: string;
	ctx: LogContext;
}

function emit(env: Envelope): void {
	const line = `${JSON.stringify(env)}\n`;

	if (stderrEnabled) {
		try {
			process.stderr.write(line);
		} catch {
			// stderr write failed; nothing to do.
		}
	}

	if (env.level !== "error") return;
	if (basePath === null) return;

	if (suppressRecursion) return;
	try {
		const dir = join(basePath, ".tff");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(join(dir, "audit-log.jsonl"), line);
	} catch (err) {
		suppressRecursion = true;
		try {
			const failLine: Envelope = {
				level: "error",
				ts: new Date().toISOString(),
				component: "logger",
				message: "audit-append-failed",
				session_id: getSessionId(),
				ctx: { error: err instanceof Error ? err.message : String(err) },
			};
			if (stderrEnabled) {
				process.stderr.write(`${JSON.stringify(failLine)}\n`);
			}
		} finally {
			suppressRecursion = false;
		}
	}
}

export function logWarning(component: LogComponent, message: string, ctx?: LogContext): void {
	emit({
		level: "warn",
		ts: new Date().toISOString(),
		component,
		message,
		session_id: getSessionId(),
		ctx: sanitize(ctx),
	});
}

export function logError(component: LogComponent, message: string, ctx?: LogContext): void {
	emit({
		level: "error",
		ts: new Date().toISOString(),
		component,
		message,
		session_id: getSessionId(),
		ctx: sanitize(ctx),
	});
}

export function logException(component: LogComponent, err: unknown, ctx?: LogContext): void {
	let message: string;
	let stack: string | undefined;
	if (err instanceof Error) {
		message = `${err.name}: ${err.message}`;
		stack = err.stack;
	} else {
		message = String(err);
		stack = undefined;
	}
	const merged = sanitize(ctx);
	if (stack !== undefined) merged.stack = stack;
	emit({
		level: "error",
		ts: new Date().toISOString(),
		component,
		message,
		session_id: getSessionId(),
		ctx: merged,
	});
}

export function readAuditLog(root?: string): AuditLogLine[] {
	const target = root ?? basePath;
	if (target === null) return [];
	const path = join(target, ".tff", "audit-log.jsonl");
	if (!fs.existsSync(path)) return [];
	const raw = fs.readFileSync(path, "utf-8");
	const out: AuditLogLine[] = [];
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		try {
			out.push(JSON.parse(line) as AuditLogLine);
		} catch {
			// Malformed line — skip. Emit stderr warning.
			if (stderrEnabled) {
				process.stderr.write(
					`${JSON.stringify({
						level: "warn",
						ts: new Date().toISOString(),
						component: "logger",
						message: "audit-log-malformed-line",
						session_id: getSessionId(),
						ctx: {},
					})}\n`,
				);
			}
		}
	}
	return out;
}
