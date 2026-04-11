# Headless Discuss Protocol

Autonomous mode — no user interaction. Document all assumptions.

## Steps

### 1. Load Context
Read preparation brief. Understand slice objective from title + milestone scope.

### 2. Investigate
Scout codebase with available tools. Check library docs if relevant.

### 3. Design
- Consider 2-3 approaches — document trade-offs in spec
- Select simplest viable (YAGNI)
- Identify error states and risks

### 4. Classify Tier
- S: trivial, skip research
- SS: standard
- SSS: complex, multi-system
Call `tff_classify(sliceId, tier)`.

### 5. Self-Review
4-point check: placeholders, consistency, scope, ambiguity. Fix inline.

### 6. Write Artifacts
Call `tff_write_spec(sliceId, content)` with SPEC.md:
- Objective, Design (selected approach + rationale + alternatives considered)
- Acceptance Criteria (measurable, binary)
- Non-Goals, Error States, Risk Assessment, Forward Intelligence
- Assumptions (every autonomous judgment documented)
- Tier, Notes

Write REQUIREMENTS.md with R-IDs, verification instructions.

## Output
SPEC.md + REQUIREMENTS.md written. Slice classified.
