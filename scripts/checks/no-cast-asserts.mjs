#!/usr/bin/env node
// scripts/checks/no-cast-asserts.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const targets = process.argv.slice(2);
if (targets.length === 0) process.exit(0); // lenient on empty

let violations = 0;
for (const path of targets) {
	const abs = resolve(path);
	const text = readFileSync(abs, "utf8");
	const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
	const visit = (n) => {
		if (ts.isAsExpression(n)) {
			const t = n.type;
			const isAsConst =
				ts.isTypeReferenceNode(t) &&
				ts.isIdentifier(t.typeName) &&
				t.typeName.escapedText === "const";
			if (!isAsConst) {
				const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
				console.error(`${abs}:${line + 1}:${character + 1}: 'as' cast is forbidden in this file`);
				violations++;
			}
		} else if (ts.isNonNullExpression(n)) {
			const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
			console.error(
				`${abs}:${line + 1}:${character + 1}: '!' non-null assertion is forbidden in this file`,
			);
			violations++;
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
}
process.exit(violations === 0 ? 0 : 1);
