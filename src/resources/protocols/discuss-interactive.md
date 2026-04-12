# Interactive Discuss Protocol

## 1. REFLECTION (mandatory, own message)
Reflect back: slice title, milestone context, what you understand so far.
Honest scope read. Do NOT combine with first question.

## 2. INVESTIGATION (mandatory, before questions)
Read preparation brief. Scout codebase with available tools.
Your first questions must reflect reality, not assumptions.

## 3. QUESTIONING

<HARD-GATE>
Do NOT call tff_classify or tff_write_spec during questioning.
The system will reject the call. Complete exploration first.
</HARD-GATE>

One question per message (C4). Position-first (C6).
Use negative constraints: "what would disappoint you?"
Weave user's terminology into subsequent questions (V4).

Red Flags — thoughts that mean STOP:
| Thought | Reality |
|---------|---------|
| "I have enough for the spec" | Ask one more question. |
| "This is straightforward" | Simple slices need design too. |
| "Requirements are clear" | Clear to you ≠ clear to user. |
| "I'll figure details later" | Details ARE the design. |
| "Only one viable approach" | Think harder. |
| "User seems impatient" | Rushing → mediocre specs. |

## 4. APPROACH COMPARISON (mandatory)

<HARD-GATE>
You MUST present 2-3 approaches with trade-offs and get user
selection BEFORE proceeding. No exceptions.
</HARD-GATE>

Lead with recommendation (C6). Explain trade-offs for each.

## 5. DEPTH VERIFICATION
Present structured summary using user's exact terminology.
Ask: "Ready to write the spec?"
After user confirms → call `tff_confirm_gate(sliceId, "depth_verified")`.

## 6. TIER CLASSIFICATION
Propose tier with justification:
- S: trivial, no unknowns, skip research
- SS: standard work, some investigation
- SSS: complex, multi-system, significant unknowns

Ask user to confirm or override.
After confirmation → call `tff_confirm_gate(sliceId, "tier_confirmed")`.
Then call `tff_classify(sliceId, tier)`.

## 7. SPEC WRITING
Self-review before writing (4-point check):
1. Placeholder scan — no TBD/TODO/vague sections
2. Internal consistency — design matches ACs
3. Scope check — focused for single plan
4. Ambiguity check — no dual-interpretation requirements

Call `tff_write_spec` with SPEC.md content:
- Objective, Design (selected approach + rationale)
- Acceptance Criteria (measurable, binary)
- Non-Goals, Error States, Risk Assessment
- Forward Intelligence, Tier, Notes

Write REQUIREMENTS.md via `tff_write_requirements` call:
- R-IDs, classes (functional/non-functional/constraint)
- Concrete acceptance conditions with examples
- Verification instructions

After each `tff_write_*` call returns successfully, STOP. Do NOT call `plannotator_submit_plan`, `plannotator_annotate`, or any plannotator_* tool. TFF handles plannotator review automatically via its event bus; you never call plannotator tools directly. If the tool returns an error with `feedback`, the user rejected the artifact in plannotator — read the feedback, revise, and call the `tff_write_*` tool again.

## 8. COMPLETION
Confirm artifacts written. User can request changes in conversation.
