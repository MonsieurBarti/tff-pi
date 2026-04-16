// CJS re-export of node:fs. When vitest intercepts `import("node:fs")` via resolve alias,
// it returns this CJS module whose properties are configurable/writable,
// enabling vi.spyOn to work in tests.
module.exports = require("node:fs");
