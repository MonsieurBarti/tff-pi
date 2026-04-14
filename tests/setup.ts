// Vitest setup file — runs once per worker before any test file loads.
// Wired up in vitest.config.ts via `test.setupFiles`.
//
// Git's pre-commit hook environment leaks a handful of GIT_* variables
// (GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX, GIT_AUTHOR_*, GIT_EXEC_PATH, …) into
// the hook command's env. If `bun run test` inherits them, every
// `execFileSync("git", ["add", …], { cwd: tempRepo })` inside a test writes
// its index entry to the OUTER worktree's index (via GIT_INDEX_FILE) while
// writing the blob to the temp repo's objects. When the temp repo is
// rmSync'd, the blob vanishes and the outer index is left pointing at a
// missing object — "ghost staging" that makes subsequent `git commit` fail
// with "invalid object … for '.tff-project-id'". GIT_INDEX_FILE alone
// reproduces it; GIT_DIR is NOT required.
//
// Scrub defensively at worker startup. scripts/scrub-git-env.sh strips these
// at the shell layer too, but belt-and-suspenders: tests should never see
// them, regardless of how they were invoked.
//
// Wildcard `startsWith("GIT_")` is intentional here (test-only). src/common/
// git.ts:GIT_REDIRECT_ENV_VARS is an explicit list because production code
// should only scrub vars we've thought about. Tests have no such constraint —
// a worker seeing ANY GIT_* var is a leak we want gone.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) {
		delete process.env[key];
	}
}
