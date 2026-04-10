# Ship Protocol

## Input
- Slice record (label, title, pr_url), SPEC.md, VERIFICATION.md, milestone branch

## Steps
1. `git push -u origin slice/<label>`
2. `gh pr create --base <milestone> --head slice/<label> --title "feat(<label>): <title>" --body <SPEC ACs + VERIFICATION>`
3. `gh pr checks <number> --watch` (CI must pass)
4. `gh pr merge <number> --squash`
5. Cleanup: `git worktree remove` + `git branch -D`
