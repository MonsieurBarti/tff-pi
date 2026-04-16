# Research Phase Protocol

## Input
- SPEC.md — slice specification with AC and design
- PROJECT.md — project context
- Slice record (id, title, tier=SS|SSS)

## Steps

### 1. Extract Questions
Parse SPEC.md for:
- Unknowns mentioned in Notes section
- Technical assumptions in Design section
- Integration points implied by AC

Formulate as explicit questions: Q1, Q2, ...

### 2. Query Codebase
For each question, use grep/glob/read to:
- Search for existing patterns/implementations
- Identify relevant APIs, types, modules
- Check for conflicts or constraints

Record: question -> finding -> source file path

### 3. Search Web (if needed)
For questions not answered by codebase:
- Use camoufox for docs, examples, best practices (search + URL fetch)
- Focus on library APIs, migration guides, known issues

Record: question -> finding -> URL

### 4. Assess Risks
From findings, identify:
- Blockers: hard constraints that affect design
- Risks: uncertain areas that need mitigation
- Dependencies: external systems or libraries needed

### 5. Write RESEARCH.md
Call `tff_write_research(sliceId, content)`:

```
# <Slice Title> — Research
## Questions
- Q1: ...
## Findings
### Q1: <question>
<answer with evidence>
Source: <path or URL>
## Risks
- R1: ...
## Dependencies
- D1: ...
## Recommendations
<Adjustments to design based on findings>
```

## Output
RESEARCH.md artifact written. Status transitions to `researching`.
