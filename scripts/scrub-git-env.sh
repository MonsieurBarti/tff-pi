#!/bin/sh
# Single source of truth for the GIT_* environment variables that must be
# stripped before running tests (or any child git process) under a pre-commit
# hook. Git sets these in the hook environment; if an `execFileSync("git", ...,
# { cwd: tempRepo })` call inherits them, the child git can redirect its view
# of the repository (index, object store, working tree) to the outer worktree
# while writing blobs to the temp repo's objects — producing "ghost staging"
# where the index points at a missing object. GIT_INDEX_FILE alone reproduces
# the failure mode.
#
# Keep this list in sync with:
#   - src/common/git.ts:GIT_REDIRECT_ENV_VARS (runtime scrub for src/ callers)
#   - tests/unit/common/git-env-scrub.spec.ts (regression guard with canary)
# tests/setup.ts uses a wildcard (startsWith("GIT_")) and needs no update.
#
# Usage: scripts/scrub-git-env.sh <command> [args...]

exec env \
	-u GIT_DIR \
	-u GIT_WORK_TREE \
	-u GIT_INDEX_FILE \
	-u GIT_PREFIX \
	-u GIT_COMMON_DIR \
	-u GIT_OBJECT_DIRECTORY \
	-u GIT_ALTERNATE_OBJECT_DIRECTORIES \
	-u GIT_AUTHOR_NAME \
	-u GIT_AUTHOR_EMAIL \
	-u GIT_AUTHOR_DATE \
	-u GIT_COMMITTER_NAME \
	-u GIT_COMMITTER_EMAIL \
	-u GIT_COMMITTER_DATE \
	-u GIT_EDITOR \
	-u GIT_EXEC_PATH \
	"$@"
