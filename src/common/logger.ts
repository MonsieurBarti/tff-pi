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
	| "replay"
	| "db"
	| "session"
	| "artifact"
	| "state-branch"
	| "snapshot"
	| "doctor"
	| "recover"
	| "ship"
	| "command"
	| "lifecycle"
	| "subagent-dispatcher";

export interface LogContext {
	fn?: string;
	tool?: string;
	mid?: string;
	sid?: string;
	worktree?: string;
	id?: string;
	error?: string;
	count?: number;
	stack?: string;
	step?: string;
	stderr?: string;
	cmd?: string;
	flag?: string;
	row?: string;
}

// "stack" is intentionally excluded: it is set only by logException from an
// auto-captured Error.stack. Caller-supplied stack strings are dropped.
const ALLOWLIST: ReadonlyArray<Exclude<keyof LogContext, "stack">> = [
	"fn",
	"tool",
	"mid",
	"sid",
	"worktree",
	"id",
	"error",
	"count",
	"step",
	"stderr",
	"cmd",
	"flag",
	"row",
];

const STACK_MAX_BYTES = 3 * 1024;
const CREDENTIAL_URL_RE = /(https?:\/\/)[^/@\s]+:[^/@\s]+@/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the goal
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

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

/**
 * Sets the audit-log base directory. `root` is the git repo root (the path
 * containing `.pi/.tff/`, which may itself be a symlink into `~/.tff/{projectId}/`),
 * not the project-home directory directly. Validated like TFF_HOME: absolute,
 * no `..`/`.` components, no NUL bytes.
 */
export function setLogBasePath(root: string): void {
	if (root.length === 0) throw new Error("setLogBasePath: root must be non-empty");
	if (root.includes("\0")) throw new Error("setLogBasePath: root contains null byte");
	if (!root.startsWith("/")) {
		throw new Error(`setLogBasePath: root must be an absolute path, got: ${root}`);
	}
	const segments = root.split("/");
	if (segments.includes("..") || segments.includes(".")) {
		throw new Error(
			`setLogBasePath: root must not contain '.' or '..' path components, got: ${root}`,
		);
	}
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

function redactString(s: string): string {
	return s.replace(CREDENTIAL_URL_RE, "$1[REDACTED]@").replace(CONTROL_CHAR_RE, "");
}

function truncateStack(s: string): string {
	const redacted = redactString(s);
	if (redacted.length <= STACK_MAX_BYTES) return redacted;
	return `${redacted.slice(0, STACK_MAX_BYTES)}…[truncated]`;
}

function sanitize(ctx: LogContext | undefined): LogContext {
	if (!ctx) return {};
	const out: LogContext = {};
	for (const key of ALLOWLIST) {
		const val = ctx[key];
		if (val === undefined) continue;
		if (key === "error") {
			out.error = redactString(typeof val === "string" ? val : String(val));
		} else if (key === "stderr") {
			out.stderr = redactString(String(val));
		} else if (typeof val === "string") {
			// biome-ignore lint/suspicious/noExplicitAny: allowlist-guarded assignment of known-keyof value
			(out as any)[key] = redactString(val);
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
		const dir = join(basePath, ".pi", ".tff");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const auditPath = join(dir, "audit-log.jsonl");
		// O_NOFOLLOW rejects the write if auditPath is a symlink — prevents a
		// caller (or prior attacker) from redirecting our sensitive append.
		const fd = fs.openSync(
			auditPath,
			fs.constants.O_WRONLY |
				fs.constants.O_APPEND |
				fs.constants.O_CREAT |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fs.writeSync(fd, line);
		} finally {
			fs.closeSync(fd);
		}
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
	const merged = sanitize(ctx);
	let message: string;
	if (err instanceof Error) {
		message = `${err.name}: ${err.message}`;
		if (err.stack !== undefined) {
			merged.stack = truncateStack(err.stack);
		}
	} else {
		message = String(err);
	}
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
	const path = join(target, ".pi", ".tff", "audit-log.jsonl");
	if (!fs.existsSync(path)) return [];
	const raw = fs.readFileSync(path, "utf-8");
	const out: AuditLogLine[] = [];
	let malformed = 0;
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		try {
			out.push(JSON.parse(line) as AuditLogLine);
		} catch {
			malformed++;
		}
	}
	if (malformed > 0 && stderrEnabled) {
		process.stderr.write(
			`${JSON.stringify({
				level: "warn",
				ts: new Date().toISOString(),
				component: "logger",
				message: "audit-log-malformed-lines",
				session_id: getSessionId(),
				ctx: { count: malformed },
			})}\n`,
		);
	}
	return out;
}
