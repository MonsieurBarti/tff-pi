# Plan Phase Protocol

## Input
- SPEC.md — slice specification with AC
- RESEARCH.md (optional) — findings and constraints
- PROJECT.md — project context
- Slice record (id, title, tier)

## Steps

### 1. Extract Acceptance Criteria
Parse SPEC.md for all AC-N entries.
These are the coverage targets — every AC must map to >=1 task.

### 2. Incorporate Research
If RESEARCH.md exists:
- Note risks that affect task ordering
- Note dependencies that create blockers
- Adjust approach per recommendations

### 3. Decompose into Tasks
For each deliverable unit:
- title: imperative verb phrase ("Add user model", "Wire auth middleware")
- description: what to do and why, files to touch
- dependsOn: array of task numbers this depends on (1-indexed)
- files: expected file paths to create/modify

Rules:
- Each task completable in ~1 agent session
- No circular dependencies (must be a DAG)
- Foundation tasks (types, config) before consumers

### 4. Verify AC Coverage
Build traceability matrix: AC-N -> [T-N, ...]
Every AC must have >=1 task. Flag gaps.

### 5. Write Plan
Call `tff_write_plan(sliceId, content, tasks)`:

content = markdown with task table + AC traceability
tasks = structured array for DB:
```json
[
  { "title": "...", "description": "...", "dependsOn": [], "files": [] },
  { "title": "...", "description": "...", "dependsOn": [1], "files": [] }
]
```

## Output
PLAN.md artifact written. Tasks + dependencies inserted in DB. Waves auto-computed.
Status transitions to `planning`.
