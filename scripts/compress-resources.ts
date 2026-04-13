#!/usr/bin/env bun
/**
 * Pre-compress TFF's shipped AI instruction files (agents/ and protocols/)
 * via ultra-compress's lexical pipeline. Writes `.original.md` backups,
 * replaces each file with the compressed version.
 *
 * Note: as of 2026-04-12 this was run at `ultra` (~1-3% reduction but
 * damages precision tokens like "Error States" → "err States") and at
 * `standard` (0% reduction — files are already concise). Decision:
 * don't commit compressed resources. Keep this script in the repo for
 * future use if the resource files grow or the level tradeoff changes.
 *
 * To run: `bunx tsx scripts/compress-resources.ts` (from tff worktree root).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compressTextLexical } from "@the-forge-flow/ultra-compress-pi";

const LEVEL = "standard" as const;

// Files to compress. Intentionally excludes executor.md and code-reviewer.md
// which are already hand-compressed in the project's existing convention.
const files = [
	"src/resources/agents/brainstormer.md",
	"src/resources/agents/planner.md",
	"src/resources/agents/researcher.md",
	"src/resources/agents/security-reviewer.md",
	"src/resources/agents/verifier.md",
	"src/resources/protocols/discuss-interactive.md",
	"src/resources/protocols/execute.md",
	"src/resources/protocols/plan.md",
	"src/resources/protocols/research.md",
	"src/resources/protocols/review.md",
	"src/resources/protocols/verify.md",
];

const root = process.cwd();

for (const rel of files) {
	const path = join(root, rel);
	const original = readFileSync(path, "utf-8");
	const { compressed, before, after } = compressTextLexical(original, LEVEL);
	writeFileSync(`${path}.original.md`, original, "utf-8");
	writeFileSync(path, compressed, "utf-8");
	const reduction = Math.round((1 - after / before) * 100);
	console.log(`${rel}: ${before} → ${after} chars (${reduction}% reduction)`);
}
