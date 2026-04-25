export function errnoCode(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const code = Reflect.get(value, "code");
	return typeof code === "string" ? code : undefined;
}
