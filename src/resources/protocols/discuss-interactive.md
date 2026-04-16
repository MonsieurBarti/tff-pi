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

After EVERY `tff_ask_user` call, END YOUR TURN IMMEDIATELY. Do not
emit any further tool calls, restatements, or "waiting..." messages.
The user's next message is their numeric reply — you must receive
it before proceeding. Calling the next tool without waiting is the
bug that causes discuss to auto-complete without user input.
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
You MUST present 2-5 approaches with trade-offs and get user
selection BEFORE proceeding. No exceptions.

Present approaches via `tff_ask_user` — NEVER as free-form prose.
The tool enforces 2-5 mutually exclusive options per question
so you cannot invent alternatives on the fly.
</HARD-GATE>

Lead with recommendation (C6). Explain trade-offs for each option's `description`.

## 5. READINESS CHECK
Present structured summary using user's exact terminology.
Ask: "Ready to write the spec?"

## 6. TIER CLASSIFICATION
Propose tier via `tff_ask_user` with a single question (id: `tier_choice`):
- S: trivial, no unknowns, skip research (still goes through review)
- SS: standard work, some investigation
- SSS: complex, multi-system, significant unknowns

Include your recommended tier as the first option. After the user selects →
call `tff_classify(sliceId, tier)`.

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

## Phase end

The discuss phase is complete when SPEC.md, REQUIREMENTS.md, and the slice tier are all set. The tool-call that completes the set will return a message containing "Stop here; the user will advance." followed by the `→ Next:` hint. When you see that, STOP. Do not call any further tools.
