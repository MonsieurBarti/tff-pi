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
- Consider 2-3 approaches for the slice objective
- Evaluate each against YAGNI, scope containment, testability
- Select simplest approach that satisfies requirements

### 3. Define Acceptance Criteria
- Extract testable conditions from requirements
- Each AC: specific, measurable, binary pass/fail
- Format: `AC-N: <condition>`

### 4. Classify Tier
- S: trivial change, no unknowns, skip research
- SS: standard work, some investigation needed
- SSS: complex, multi-system, significant unknowns
- Call `tff_classify(sliceId, tier)`

### 5. Write SPEC.md
Compose and call `tff_write_spec(sliceId, content)`:

```
# <Slice Title> — Spec
## Objective
<1-2 sentences>
## Design
<Selected approach with rationale>
## Acceptance Criteria
- AC-1: ...
- AC-2: ...
## Tier: <S|SS|SSS>
## Notes
<Tier justification, constraints, open questions>
```

## Output
SPEC.md artifact written. Slice classified. Status transitions to `discussing`.
