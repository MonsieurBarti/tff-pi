# Plan Phase Protocol

<HARD-GATE>
The plan phase is NOT COMPLETE until `tff_write_plan` returns successfully
with at least one task. Writing PLAN.md via Write/Edit/filesystem does NOT
count — the database must contain tasks with computed waves.

If you cannot produce a structured task list (because the spec is ambiguous,
for example), STOP and call `tff_ask_user` with 2-3 curated options
clarifying the ambiguity. Do NOT write prose in place of a plan.

Only `tff_write_plan` signals phase_complete. Any other exit = phase stuck.
</HARD-GATE>


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

### 5. Ask User Before Committing (when ambiguous)
If task decomposition has a real fork (e.g., "split auth into 2 tasks vs 4",
"use Prisma vs raw SQL"), use `tff_ask_user` with 2-3 curated options
BEFORE calling `tff_write_plan`. Never invent options in free-form prose.

### 6. Write Plan
Call `tff_write_plan(sliceId, content, tasks)`:

content = markdown with task table + AC traceability
tasks = structured array for DB:
```json
[
  { "title": "...", "description": "...", "dependsOn": [], "files": [] },
  { "title": "...", "description": "...", "dependsOn": [1], "files": [] }
]
```

After the tool returns successfully, STOP. Do not call any other tools. The system handles plan review automatically — do NOT call `plannotator_submit_plan`, `plannotator_annotate`, or any plannotator_* tool. TFF emits the review request on an event bus; plannotator opens its UI modal; the tool return only resolves after the user approves in the UI.

If the tool returns an error with `feedback`, the user rejected the plan in plannotator. Read the feedback, revise, and call `tff_write_plan` again with the updated content.

## Output
PLAN.md artifact written. Tasks + dependencies inserted in DB. Waves auto-computed.
Phase transitions to `executing` when the user runs `/tff next`.
