import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ProtectedBranchConfig {
	readonly branches: readonly string[];
	readonly defaultBranchProtected: boolean;
}

export const DEFAULT_PROTECTED: ProtectedBranchConfig = {
	branches: ["main", "master"],
	defaultBranchProtected: true,
};

export type HookInstallStatus =
	| "installed"
	| "installed-no-hookspath"
	| "skipped-already-installed"
	| "error";

export interface HookInstallResult {
	status: HookInstallStatus;
	details?: string;
}

/**
 * The pre-push hook script template. PROTECTED_LIST is substituted at generation
 * time with the static branch names; the default-branch detection runs at hook
 * execution time via `git symbolic-ref`.
 */
function buildHookScript(staticBranches: readonly string[]): string {
	// Shell-quote each branch name (they're well-known constants — no special chars expected)
	const branchList = staticBranches.map((b) => JSON.stringify(b)).join(" ");
	return `#!/usr/bin/env bash
# TFF protected-branch pre-push hook — rejects direct pushes to main/master/<default>
# To bypass: \`git push --no-verify\` (indicates TFF workflow drift; use only if you know what you're doing)

set -euo pipefail

PROTECTED=(${branchList})

# Dynamic default branch (if origin has one configured)
DEFAULT_REF=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$DEFAULT_REF" ]; then
  DEFAULT_BRANCH="\${DEFAULT_REF#refs/remotes/origin/}"
  PROTECTED+=("$DEFAULT_BRANCH")
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  # Extract branch name from remote ref (refs/heads/X -> X)
  remote_branch="\${remote_ref#refs/heads/}"
  for protected in "\${PROTECTED[@]}"; do
    if [ "$remote_branch" = "$protected" ]; then
      cat >&2 <<'ERRMSG'

TFF guardrail: direct push to protected branch blocked.

Per the TFF workflow:
  - Slice PRs merge to the milestone branch (never to main/master).
  - Milestone branches merge to the default branch via a milestone PR.
  - Never push to main/master directly or merge milestone into main from the client.

If you genuinely need this push, bypass with:  git push --no-verify
This message appearing during a TFF session means the agent attempted an out-of-workflow push.
ERRMSG
      echo >&2 "Blocked branch: $remote_branch"
      exit 1
    fi
  done
done

exit 0
`;
}

/**
 * Build a README explaining how to chain the TFF pre-push hook when the user
 * already has their own hooksPath (husky, lefthook, etc.).
 */
function buildReadme(hookPath: string): string {
	return `# TFF Protected-Branch Hook

TFF detected you already have \`core.hooksPath\` configured (e.g., husky or lefthook).
To activate the protected-branch guard, add the following call to your existing pre-push hook:

\`\`\`bash
# Chain TFF protected-branch check
if [ -x "${hookPath}" ]; then
  "${hookPath}"
fi
\`\`\`

Or, if your hook runner supports it, add TFF's hook directory as an additional hook source.

**Why this matters:** TFF's workflow invariant is that main/master must only receive
commits via milestone-to-main PRs. Direct pushes bypass the entire PR gate.
`;
}

/**
 * Install a pre-push hook at .tff/hooks/pre-push that rejects pushes to
 * protected branches. Idempotent: re-writing is always safe (the script is
 * deterministic from the config).
 *
 * core.hooksPath behaviour:
 *  - If unset: set to `.tff/hooks` → status "installed"
 *  - If already `.tff/hooks`: leave it → status "installed" (idempotent)
 *  - If set to something else (husky/lefthook): don't clobber; write a README
 *    in .tff/hooks/ explaining how to chain → status "installed-no-hookspath"
 *
 * Returns "error" + details if anything throws unexpectedly.
 */
export function installProtectedBranchHook(
	root: string,
	config: ProtectedBranchConfig = DEFAULT_PROTECTED,
): HookInstallResult {
	try {
		const hookDir = resolve(root, ".tff", "hooks");
		mkdirSync(hookDir, { recursive: true });

		const hookPath = resolve(hookDir, "pre-push");
		const script = buildHookScript(config.branches);
		writeFileSync(hookPath, script, { encoding: "utf-8" });
		chmodSync(hookPath, 0o755);

		// Determine current core.hooksPath value
		let currentHooksPath: string | null = null;
		try {
			currentHooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
				cwd: root,
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
		} catch {
			// exit code 1 means the key is unset — that's fine
			currentHooksPath = null;
		}

		const tffHooksRelPath = ".tff/hooks";

		if (currentHooksPath === null) {
			// Unset — claim it for TFF
			execFileSync("git", ["config", "core.hooksPath", tffHooksRelPath], {
				cwd: root,
				encoding: "utf-8",
				stdio: "pipe",
			});
			return { status: "installed" };
		}

		if (currentHooksPath === tffHooksRelPath) {
			// Already ours — idempotent, nothing to do
			return { status: "installed" };
		}

		// User has their own hook setup — write a README explaining how to chain
		const readmePath = resolve(hookDir, "README.md");
		writeFileSync(readmePath, buildReadme(hookPath), { encoding: "utf-8" });

		return {
			status: "installed-no-hookspath",
			details: `core.hooksPath is set to "${currentHooksPath}" (not overwritten). The TFF pre-push script was written to ${hookPath}. To activate it, chain it from your existing pre-push hook. See ${readmePath} for instructions.`,
		};
	} catch (err) {
		return {
			status: "error",
			details: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Check whether a git push command string targets a protected branch.
 * Used by the PI tool_call interceptor for live-session defense-in-depth.
 *
 * Matches patterns like:
 *   git push origin main
 *   git push origin HEAD:main
 *   git push --force origin master
 *
 * Does NOT attempt to match every possible git push syntax — this is a
 * best-effort trip-wire. The pre-push hook is the authoritative guard.
 *
 * Returns the matched branch name if blocked, or null if allowed.
 */
export function detectProtectedPush(
	command: string,
	protectedBranches: readonly string[],
): string | null {
	// Must contain "git" and "push"
	if (!/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return null;
	// --no-verify bypasses the hook — also respect it in the interceptor
	if (/--no-verify/.test(command)) return null;

	for (const branch of protectedBranches) {
		// Match: origin main | origin HEAD:main | origin refs/heads/main
		// Use word boundaries so "maintain" doesn't match "main"
		const patterns = [
			// bare branch at end: git push origin main
			new RegExp(`\\b${escapeRegex(branch)}\\s*$`),
			// refspec: HEAD:main or origin/main
			new RegExp(`[:/]${escapeRegex(branch)}\\b`),
		];
		for (const pattern of patterns) {
			if (pattern.test(command)) return branch;
		}
	}
	return null;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
