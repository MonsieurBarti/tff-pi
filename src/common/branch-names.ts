// Validates raw branch-name strings against an allow-list and rejects
// path-traversal segments. Boundary defense before any value reaches `git`.
// For composing TFF-domain branch names from slice/milestone entities,
// see ./branch-naming.ts.
//
// Two layers of defense:
//   1. Allow-list regex for safe characters.
//   2. Explicit rejection of path-traversal components (`..`, absolute paths).
// git's check-ref-format provides a third layer, but we want to reject
// malicious inputs at our own boundary before they reach git args.

export const BRANCH_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._/\-]*$/;

export class InvalidBranchName extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidBranchName";
	}
}

export function isValidBranchName(name: string): boolean {
	if (typeof name !== "string" || name.length === 0) return false;
	if (!BRANCH_NAME_RE.test(name)) return false;
	// Reject path-traversal: any segment that is exactly ".." or "." is unsafe.
	const segments = name.split("/");
	for (const s of segments) {
		if (s === "." || s === "..") return false;
		if (s.length === 0) return false; // no leading/trailing/double slashes
	}
	// Reject things that look like flags (belt-and-suspenders — the leading-char
	// rule already forbids `-`, but an explicit check is cheap).
	if (name.startsWith("-")) return false;
	return true;
}

export function assertValidBranchName(name: string, label = "branch"): void {
	if (!isValidBranchName(name)) {
		throw new InvalidBranchName(`invalid ${label} name: ${JSON.stringify(name)}`);
	}
}
