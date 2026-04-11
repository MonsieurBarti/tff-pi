# Discuss Phase Protocol

## Input
- PROJECT.md — project vision & context
- REQUIREMENTS.md — milestone requirements
- Slice record (id, title, status)

## Steps

### 1. Load Context
Read PROJECT.md and REQUIREMENTS.md from .tff artifacts.
Identify the slice objective from its title and milestone scope.

### 2. Brainstorm Design
- Propose 2-3 approaches for the slice objective (mandatory)
- Evaluate each against YAGNI, scope containment, testability
- Select simplest approach that satisfies requirements

### 3. Define Acceptance Criteria
- Extract testable conditions from requirements
- Each AC: specific, measurable, binary pass/fail
- Format: `AC-N: <condition>`
- Quality: vague "fast search" → concrete "returns <200ms for 10k rows"

### 4. Define Non-Goals
- Explicitly list what this slice does NOT do
- Format: `NG-N: <exclusion>`

### 5. Classify Tier
- S: trivial change, no unknowns, skip research
- SS: standard work, some investigation needed
- SSS: complex, multi-system, significant unknowns
- Call `tff_classify(sliceId, tier)`

### 6. Self-Review
Scan output for TBD/TODO/placeholders/contradictions. Fix inline.

### 7. Write SPEC.md
Call `tff_write_spec(sliceId, content)`:

```
# <Slice Title> — Spec
## Objective
<1-2 sentences>
## Design
<Selected from 2-3 approaches, with rationale>
## Acceptance Criteria
- AC-1: <specific, measurable, binary>
- AC-2: ...
## Non-Goals
- NG-1: ...
## Tier: <S|SS|SSS>
## Notes
<Tier justification, constraints, open questions>
```

## Output
SPEC.md artifact written. Slice classified. Status transitions to `discussing`.
