import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"node:fs": join(__dirname, "tests/mocks/node-fs.cjs"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.spec.ts"],
		exclude: ["node_modules", "dist"],
		setupFiles: ["tests/setup.ts"],
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
