import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.spec.ts"],
		exclude: ["node_modules", "dist"],
		// Alias hippo-memory-pi to a stub. The real package transitively
		// imports `node:sqlite` at module load, which Bun on Linux x64
		// (used in CI) does not provide. Tests don't exercise real memory
		// anyway — memory.spec.ts uses its own vi.mock which takes
		// precedence over this alias inside that file.
		alias: {
			"@the-forge-flow/hippo-memory-pi": fileURLToPath(
				new URL("./tests/stubs/hippo-memory-pi.ts", import.meta.url),
			),
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules", "dist", "tests/**/*.spec.ts"],
			lines: 80,
			functions: 80,
			branches: 80,
			statements: 80,
		},
	},
});
