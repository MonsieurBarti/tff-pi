import { type ExtensionAPI, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import { deleteArtifact, writeArtifact } from "../common/artifacts.js";
import { type TffContext, getDb } from "../common/context.js";
import { resolveSlice } from "../common/db-resolvers.js";
import { getMilestone, getSlice } from "../common/db.js";
import { auditVerification, formatAuditReport } from "../common/evidence-auditor.js";
import { emitPhaseCompleteIfArtifactsReady } from "../common/phase-completion.js";
import { milestoneLabel, sliceLabel } from "../common/types.js";
import { verifyPhaseArtifacts } from "../orchestrator.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function handleWriteVerification(
	db: Database.Database,
	root: string,
	sliceId: string,
	content: string,
): ToolResult {
	const slice = getSlice(db, sliceId);
	if (!slice) {
		return {
			content: [{ type: "text", text: `Slice not found: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const milestone = getMilestone(db, slice.milestoneId);
	if (!milestone) {
		return {
			content: [{ type: "text", text: `Milestone not found for slice: ${sliceId}` }],
			details: { sliceId },
			isError: true,
		};
	}
	const label = sliceLabel(milestone.number, slice.number);
	const mLabel = milestoneLabel(milestone.number);
	const path = `milestones/${mLabel}/slices/${label}/VERIFICATION.md`;
	writeArtifact(root, path, content);
	return {
		content: [{ type: "text", text: `VERIFICATION.md written for ${label}.` }],
		details: { sliceId, path },
	};
}

export function register(pi: ExtensionAPI, ctx: TffContext): void {
	pi.registerTool(
		defineTool({
			name: "tff_write_verification",
			label: "TFF Write Verification",
			description:
				"Write VERIFICATION.md for a slice. THIS IS THE ONLY TOOL THAT MARKS THE VERIFY PHASE COMPLETE — phase_complete fires here. Use it to persist AC PASS/FAIL results and test output after the verify phase.",
			promptSnippet:
				"The verify phase is not complete until tff_write_verification returns successfully. Writing the file via Write/Edit will not mark the phase complete.",
			promptGuidelines: [
				"Include an AC checklist with [x]/[ ] markers so the ship pre-flight check can scan it",
				"Include the test command run and its output summary (pass/fail counts)",
				"On failures: mark the AC [ ] and describe what broke + which task(s) to re-execute",
			],
			parameters: Type.Object({
				sliceId: Type.String({
					description: "Slice ID (UUID) or label (e.g., M01-S01)",
				}),
				content: Type.String({
					description: "Markdown content of VERIFICATION.md",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const database = getDb(ctx);
					const root = ctx.projectRoot;
					if (!root) {
						return {
							content: [{ type: "text", text: "Error: No project root found." }],
							details: {},
							isError: true,
						};
					}
					const slice = resolveSlice(database, params.sliceId);
					if (!slice) {
						return {
							content: [{ type: "text", text: `Slice not found: ${params.sliceId}` }],
							details: { sliceId: params.sliceId },
							isError: true,
						};
					}

					const milestone = getMilestone(database, slice.milestoneId);
					if (!milestone) {
						return {
							content: [{ type: "text", text: `Milestone not found for slice: ${slice.id}` }],
							details: { sliceId: slice.id },
							isError: true,
						};
					}

					const writeResult = handleWriteVerification(database, root, slice.id, params.content);
					if (writeResult.isError) return writeResult;

					const auditReport = auditVerification(database, slice.id, params.content);

					const mLabel = milestoneLabel(milestone.number);
					const sLabel = sliceLabel(milestone.number, slice.number);
					const auditPath = `milestones/${mLabel}/slices/${sLabel}/VERIFICATION-AUDIT.md`;
					const blockedPath = `milestones/${mLabel}/slices/${sLabel}/.audit-blocked`;

					if (auditReport.findings.length > 0) {
						writeArtifact(root, auditPath, formatAuditReport(auditReport));
					} else {
						// No findings this run — remove any stale artifact from a prior
						// mismatching run so readers don't see outdated claims.
						deleteArtifact(root, auditPath);
					}

					if (auditReport.hasMismatches) {
						// Persist the block so a later phase transition can't bypass the gate
						// via closePredecessorIfReady's artifact-existence-only check.
						writeArtifact(
							root,
							blockedPath,
							"Audit found mismatches. See VERIFICATION-AUDIT.md.\n",
						);
						return {
							content: [
								{
									type: "text",
									text: `VERIFICATION.md written, but AUDIT found ${auditReport.summary.mismatch} mismatch(es). phase_complete NOT emitted. Correct the claims that don't match captured tool-call evidence and call tff_write_verification again.\n\n${formatAuditReport(auditReport)}`,
								},
							],
							details: {
								sliceId: slice.id,
								path: auditPath,
								mismatches: auditReport.summary.mismatch,
							},
							isError: true,
						};
					}

					// Audit clean — clear any stale block marker from a prior mismatching run.
					deleteArtifact(root, blockedPath);

					const hint = emitPhaseCompleteIfArtifactsReady(
						pi,
						database,
						root,
						slice,
						"verify",
						verifyPhaseArtifacts,
					);
					if (hint) {
						return {
							...writeResult,
							content: [
								{
									type: "text" as const,
									text: `${writeResult.content[0]?.text ?? ""}\n\n${hint}`,
								},
							],
						};
					}
					return writeResult;
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
						],
						details: { sliceId: params.sliceId },
						isError: true,
					};
				}
			},
		}),
	);
}
