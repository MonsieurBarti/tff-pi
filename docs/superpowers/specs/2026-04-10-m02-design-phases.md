# M02: Design Phases — Specification

## Scope

M02 adds the three design phases of the slice lifecycle (discuss, research, plan), the orchestrator skeleton for step/auto progression, and the supporting infrastructure for sub-agent dispatch, plannotator review gates, and ecosystem integration.

### What M02 Delivers

- Refactored `/tff new` — project initialization only (no milestone/slices)
- `/tff new-milestone` — milestone creation with brainstormed requirements + slice decomposition
- `/tff discuss [slice]` — brainstorm slice design → SPEC.md + tier classification + plannotator gate
- `/tff research [slice]` — technical investigation → RESEARCH.md (tier-gated)
- `/tff plan [slice]` — task decomposition + wave detection → PLAN.md + plannotator gate
- `/tff next` — advance one phase (step mode)
- `/tff auto` — loop through phases, stopping at human gates
- `/tff pause` — pause active slice with checkpoint
- `tff_create_slice` tool — ad-hoc slice creation
- `tff_write_spec` / `tff_write_research` / `tff_write_plan` tools
- Orchestrator spine (state → phase routing → dispatch → advance)
- Sub-agent dispatch integration (sub-agents extension)
- Plannotator review integration (shared event API)
- Ecosystem tool integration (gitnexus, lightpanda, hippo-memory)
- Hand-written compressed agent/protocol prompts
- `compress()` pass-through via sub-agent prompt flag for user artifacts

### What M02 Does NOT Deliver

- Execution phase (M03)
- Verification & ship phases (M04)
- Rollback, state branches, TUI overlays (M05)
- Git worktree lifecycle (M03)
- Review pipeline / reviewer agents (M04)
- `tff_checkpoint` tool (M03)

---

## Refactored `/tff new`

**Current M01 behavior:** Creates project + first milestone + slices.

**M02 behavior:** Project initialization only.
- Creates project record in SQLite (name, vision)
- Initializes `.tff/` directory
- Writes `PROJECT.md`
- Writes `settings.yaml` with defaults
- No milestone, no slices

**Impact:**
- `NewProjectInput` loses `milestoneName` and `slices` fields
- `handleNew` simplified to project-only logic
- `tff_create_project` tool params trimmed accordingly
- Tests updated

---

## `/tff new-milestone [name]`

Creates a milestone and dispatches a sub-agent to brainstorm its scope.

**Command handler (`src/commands/new-milestone.ts`):**
1. Auto-increment milestone number from DB
2. Create milestone record in SQLite
3. Create milestone branch (`milestone/M##`)
4. Initialize `.tff/milestones/M##/` directory
5. Dispatch sub-agent with `PROJECT.md` to brainstorm:
   - Milestone requirements → writes `REQUIREMENTS.md`
   - Slice decomposition → creates slices via `tff_create_slice`

**`tff_create_slice` tool (`src/tools/create-slice.ts`):**
- Params: `milestoneId: string`, `title: string`
- Auto-increments slice number within the milestone
- Creates slice record in SQLite (status: `created`, tier: `null`)
- Initializes slice directory (`.tff/milestones/M##/slices/M##-S##/`)
- Returns slice ID and label

---

## Orchestrator

**`src/orchestrator.ts`** — the central loop that reads state and routes to phases.

### Core Loop

```
readState(db) → findActiveSlice(db) → determineNextPhase(slice) → dispatchPhase(phase, context) → advanceState(db, slice) → repeat or pause
```

### Functions

- `findActiveSlice(db)` — returns the first non-closed, non-paused slice in the current milestone (ordered by number). One active slice at a time.
- `determineNextPhase(slice)` — reads slice status, returns the next phase to dispatch. Maps status to phase: `created → discuss`, `discussing → research` (or `planning` for S-tier), `researching → plan`.
- `dispatchPhase(ctx, phase, slice, root)` — calls the phase handler's `collectContext` → `buildPrompt` → dispatches via sub-agents → calls `processResult`.
- `advanceState(db, slice, outcome)` — transitions slice status via state machine.

### Phase Handler Contract

Each phase module exports a handler conforming to:

```typescript
interface PhaseHandler {
  collectContext(db: Database, root: string, slice: Slice): PhaseContext;
  buildPrompt(ctx: PhaseContext, compressed: boolean): SubAgentPrompt;
  processResult(db: Database, root: string, slice: Slice, result: SubAgentResult): PhaseOutcome;
}
```

- `collectContext` — gathers artifacts relevant to this phase
- `buildPrompt` — constructs sub-agent prompt from compressed agent identity + protocol + artifacts. When `compressed` is true (from `settings.compress.user_artifacts`), instructs the sub-agent to write artifacts in compressed R1-R10 notation.
- `processResult` — handles sub-agent output: writes artifacts, updates DB, returns outcome

### Modes

- **Step mode** (default): `/tff next` calls the orchestrator for one phase, then returns.
- **Auto mode**: `/tff auto` sets a runtime flag. Orchestrator loops until hitting a human gate (plannotator review after discuss/plan) or completing all phases through planning.
- **Pause**: `/tff pause` sets slice status to `paused`. `/tff next` resumes from the paused phase.

### Human Gate Handling

After discuss and plan phases complete, the orchestrator triggers a plannotator review before advancing. In auto mode, the loop blocks until the review result arrives.

---

## Discuss Phase

**Trigger:** Slice status `created` → `discussing`

### Context Injected

- `PROJECT.md` (project vision)
- `REQUIREMENTS.md` (milestone acceptance criteria)
- Compressed agent identity (`resources/agents/brainstormer.md`)
- Compressed protocol (`resources/protocols/discuss.md`)

### Sub-Agent Task

Brainstorm the slice's design. Produce:
- Design decisions and architecture for this slice
- Acceptance criteria specific to the slice
- Complexity tier recommendation (S/SS/SSS) with reasoning

### Tools Available to Sub-Agent

- `tff_write_spec` — writes SPEC.md
- `tff_classify` — sets slice tier (existing M01 tool)

### After Completion

1. `processResult` verifies SPEC.md was written and tier was set
2. Orchestrator triggers plannotator spec review via `plannotator:request` event
3. Listens on `plannotator:review-result`
4. **Approve** → transition `discussing → researching` (or `→ planning` if S-tier)
5. **Deny** → dispatch a fresh sub-agent with the existing SPEC.md + review feedback to revise, then re-submit for review (same gate flow)

---

## Research Phase

**Trigger:** Slice status `discussing` → `researching`

### Skip Logic

- **S-tier:** Skip entirely (`discussing → planning`)
- **SS-tier:** Optional — sub-agent can conclude early if research isn't needed
- **SSS-tier:** Required — must produce substantive findings

### Context Injected

- `SPEC.md` (from discuss phase)
- `PROJECT.md` (project context)
- Compressed agent identity (`resources/agents/researcher.md`)
- Compressed protocol (`resources/protocols/research.md`)

### Tools Available to Sub-Agent

- `tff_write_research` — writes RESEARCH.md
- gitnexus tools — code structure queries
- lightpanda tools — web search
- hippo-memory — recall/store findings

### Sub-Agent Task

Investigate technical questions from SPEC.md. Produce:
- Library/API/pattern findings
- Codebase analysis (existing patterns, files to modify)
- Risks and constraints
- Recommendations for the plan phase

### After Completion

1. `processResult` verifies RESEARCH.md was written (required for SSS, optional for SS)
2. No human gate — research is informational
3. Transition `researching → planning`

---

## Plan Phase

**Trigger:** Slice status `researching` → `planning` (or `discussing → planning` for S-tier)

### Context Injected

- `SPEC.md` (design + acceptance criteria)
- `RESEARCH.md` (if exists)
- `PROJECT.md` (project context)
- Compressed agent identity (`resources/agents/planner.md`)
- Compressed protocol (`resources/protocols/plan.md`)

### Tools Available to Sub-Agent

- `tff_write_plan` — writes PLAN.md with structured task breakdown
- `tff_create_slice` — in case planning reveals the slice should be split
- gitnexus tools — code structure queries for impact analysis

### Sub-Agent Task

Decompose SPEC.md into executable tasks. Produce:
- Ordered task list with titles, descriptions, file map
- Task-to-task dependencies
- Wave assignment (independent tasks grouped for parallel execution)
- AC traceability (each task maps to SPEC.md acceptance criteria)

### After Completion

1. `processResult` parses structured output:
   - Creates task records in SQLite
   - Creates dependency records
   - Computes waves via topological sort
   - Updates task records with wave numbers
2. Writes PLAN.md to disk
3. Orchestrator triggers plannotator plan review
4. **Approve** → transition `planning → executing` (M02 stops here — execution is M03)
5. **Deny** → dispatch a fresh sub-agent with the existing PLAN.md + review feedback to revise, then re-submit for review

---

## AI Tools

### `tff_write_spec`

- **Params:** `sliceId: string`, `content: string`
- Resolves slice → milestone path
- Writes SPEC.md to `.tff/milestones/M##/slices/M##-S##/SPEC.md`
- Returns confirmation with path

### `tff_write_research`

- **Params:** `sliceId: string`, `content: string`
- Writes RESEARCH.md to the slice directory
- Returns confirmation with path

### `tff_write_plan`

- **Params:** `sliceId: string`, `content: string`, `tasks: Array<{ title: string, description: string, dependsOn?: number[], files?: string[] }>`
- Writes PLAN.md content to disk
- Creates task + dependency records in SQLite
- Runs topological sort, assigns wave numbers
- Returns confirmation with task count and wave count

### `tff_create_slice` (described above)

---

## Sub-Agent Dispatch Integration

### `src/common/dispatch.ts`

```typescript
interface SubAgentPrompt {
  systemPrompt: string;    // compressed agent identity + protocol
  userPrompt: string;      // phase task with injected artifacts
  tools: string[];         // tools available to sub-agent
  label: string;           // visible in sub-agents TUI (e.g. "M01-S01: discuss")
}

interface SubAgentResult {
  success: boolean;
  output: string;
}
```

- `dispatchSubAgent(ctx: ExtensionContext, prompt: SubAgentPrompt): Promise<SubAgentResult>` — calls the sub-agents extension's dispatch tool, waits for completion, returns result

### `src/common/review.ts`

- `requestReview(ctx: ExtensionContext, artifactPath: string, reviewType: "spec" | "plan"): Promise<ReviewResult>` — emits `plannotator:request`, listens on `plannotator:review-result`
- `ReviewResult: { approved: boolean, feedback?: string }`

### Hippo-Memory

No explicit integration code needed. It hooks into sessions automatically via its lifecycle hooks. Sub-agents dispatched with hippo-memory available will have memory access.

---

## Compressed Agent & Protocol Prompts

Hand-written in R1-R10 compressed notation:

```
src/resources/
  agents/
    brainstormer.md    — discuss phase identity
    researcher.md      — research phase identity
    planner.md         — plan phase identity
  protocols/
    discuss.md         — discuss phase workflow
    research.md        — research phase workflow
    plan.md            — plan phase workflow
```

Each agent prompt is under 500 tokens. Defines role, constraints, quality bar.

Each protocol prompt defines the step-by-step workflow for the phase, tool usage expectations, and output format.

Content informed by researching: superpowers skills (brainstorming, writing-plans), TFF-CC agents, GSD-2 auto-prompts.

### User Artifact Compression

When `settings.compress.user_artifacts` is `true`, the sub-agent prompt includes a flag instructing it to write SPEC.md / RESEARCH.md / PLAN.md in compressed R1-R10 notation. No separate `compress()` transform function — the sub-agent handles it directly.

---

## Wave Computation

### `src/common/waves.ts`

- `computeWaves(tasks: Task[], dependencies: Dependency[]): Map<string, number>`
- Takes task records + dependency edges
- Topological sort groups independent tasks into waves:
  - Wave 1: tasks with no dependencies
  - Wave 2: tasks depending only on wave 1 tasks
  - Wave N: tasks depending only on wave 1..N-1 tasks
- Detects cycles and throws
- Returns map of taskId → wave number

### New DB Operations

- `insertDependency(db, fromTaskId, toTaskId)` — new
- `updateTaskWave(db, taskId, wave)` — new
- `getTasksBySlice(db, sliceId)` — exists (M01)
- `getDependencies(db, sliceId)` — exists (M01)

---

## Module Layout

### New Files

```
src/
  orchestrator.ts
  common/
    dispatch.ts
    review.ts
    waves.ts
  commands/
    new-milestone.ts
    discuss.ts
    research.ts
    plan.ts
    next.ts
    auto.ts
    pause.ts
  tools/
    create-slice.ts
    write-spec.ts
    write-research.ts
    write-plan.ts
  resources/
    agents/
      brainstormer.md
      researcher.md
      planner.md
    protocols/
      discuss.md
      research.md
      plan.md
```

### Modified Files (from M01)

```
src/
  index.ts              — register new commands + tools
  commands/
    new.ts              — simplified to project-only
  tools/
    create-project.ts   — simplified params
  common/
    db.ts               — add insertDependency, updateTaskWave
    router.ts           — add new subcommands to whitelist
```

### Unchanged Files (from M01)

```
src/
  common/
    types.ts
    state-machine.ts
    artifacts.ts
    settings.ts
    git.ts
  commands/
    status.ts
    progress.ts
    health.ts
  tools/
    query-state.ts
    transition.ts
    classify.ts
```

### Tests

```
tests/unit/
  orchestrator.spec.ts
  common/
    dispatch.spec.ts
    review.spec.ts
    waves.spec.ts
    db.spec.ts              — updated for new functions
  commands/
    new.spec.ts             — updated
    new-milestone.spec.ts
    discuss.spec.ts
    research.spec.ts
    plan.spec.ts
    next.spec.ts
    auto.spec.ts
    pause.spec.ts
  tools/
    create-slice.spec.ts
    write-spec.spec.ts
    write-research.spec.ts
    write-plan.spec.ts
    create-project.spec.ts  — updated
```

---

## Acceptance Criteria

1. `/tff new` creates only a project (no milestone or slices)
2. `/tff new-milestone` creates a milestone and dispatches a sub-agent that brainstorms requirements and decomposes slices
3. `/tff discuss` dispatches a brainstormer sub-agent that produces SPEC.md and classifies tier, followed by plannotator spec review (human gate)
4. `/tff research` dispatches a researcher sub-agent that produces RESEARCH.md; skips for S-tier
5. `/tff plan` dispatches a planner sub-agent that produces PLAN.md with tasks, dependencies, and waves, followed by plannotator plan review (human gate)
6. `/tff next` advances one phase via the orchestrator
7. `/tff auto` loops through phases stopping at human gates
8. `/tff pause` pauses the active slice
9. `tff_create_slice` creates slices ad-hoc
10. `tff_write_spec`, `tff_write_research`, `tff_write_plan` write artifacts to correct paths
11. Wave computation correctly groups independent tasks and detects cycles
12. Sub-agent dispatch integrates with the sub-agents extension
13. Plannotator review integrates via shared event API for spec and plan gates
14. Compressed agent/protocol prompts exist for all three phases
15. User artifact compression works via prompt flag when `settings.compress.user_artifacts` is true
16. All new code has unit tests maintaining 80% coverage target
