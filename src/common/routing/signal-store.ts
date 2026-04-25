import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sliceDir } from "../artifacts.js";
import { type Signals, SignalsSchema } from "./signals.js";

export function signalsPath(root: string, milestoneNumber: number, sliceNumber: number): string {
	return join(sliceDir(root, milestoneNumber, sliceNumber), "signals.json");
}

export async function writeSignals(
	root: string,
	milestoneNumber: number,
	sliceNumber: number,
	signals: Signals,
): Promise<void> {
	const path = signalsPath(root, milestoneNumber, sliceNumber);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(signals, null, 2)}\n`, "utf8");
}

export async function readSignals(
	root: string,
	milestoneNumber: number,
	sliceNumber: number,
): Promise<Signals | null> {
	const path = signalsPath(root, milestoneNumber, sliceNumber);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const parsed = JSON.parse(raw); // throws on malformed JSON
	return Value.Parse(SignalsSchema, parsed); // throws on schema violation
}
