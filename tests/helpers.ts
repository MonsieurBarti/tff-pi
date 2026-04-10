/**
 * Assert a value is not null/undefined and return it narrowed.
 * Use in tests instead of non-null assertion (!) to satisfy biome.
 */
export function must<T>(value: T | null | undefined, msg = "Expected value to be defined"): T {
	if (value == null) throw new Error(msg);
	return value;
}
