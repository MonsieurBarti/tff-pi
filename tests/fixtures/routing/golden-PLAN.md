<!-- Stable fixture for estimateAffectedFiles. Pinned counts:
     - 3 task headers (## Task T01, ## Task T02, ### Task T03)
     - 4 unique file mentions, with src/common/foo.ts duplicated to exercise dedup
     - count = max(taskCount=3, files=4) = 4
     If you edit, update affected-files.spec.ts pins to match. -->
# Plan — Fixture

## File Structure

- src/common/foo.ts — port helper
- tests/unit/common/foo.spec.ts — unit tests

## Task T01: write failing test

- tests/unit/common/foo.spec.ts

## Task T02: implement helper

- src/common/foo.ts

### Task T03: wire into phase

- src/phases/bar.ts
- src/common/foo.ts
- tests/unit/common/baz.spec.ts
