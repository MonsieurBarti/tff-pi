// Vitest setup file — runs once per worker before any test file loads.
// Wired up in vitest.config.ts via `test.setupFiles`.
//
// Fail-fast guard against the GIT_DIR leak pattern: if GIT_DIR or
// GIT_WORK_TREE is set in the suite's environment (e.g. lefthook pre-commit
// hooks set GIT_DIR), any `execSync("git config ...", { cwd: tmpRepo })`
// inside a test will write to the env-dir instead of the tmp repo, silently
// polluting the outer worktree's git config. Throw loudly here so the leak
// is caught immediately — cheaper to fix one env var than to force-push
// rewritten commits after noticing wrong author on a PR.
for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
	if (process.env[key]) {
		throw new Error(
			`${key} is set in the test environment (value: ${process.env[key]}). This causes git config writes in tests to leak into the outer repo. Unset it before running tests (e.g., scrub GIT_* in lefthook pre-commit).`,
		);
	}
}
