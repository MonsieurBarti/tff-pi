<div align="center">
  <img src="https://raw.githubusercontent.com/MonsieurBarti/The-Forge-Flow-CC/refs/heads/main/assets/forge-banner.png" alt="The Forge Flow" width="100%">
  
  <h1>🔧 TFF PI Extension Template</h1>
  
  <p>
    <strong>Starter kit for building PI coding agent extensions</strong>
  </p>
  
  <p>
    <a href="https://github.com/MonsieurBarti/tff-pi/actions/workflows/ci.yml">
      <img src="https://img.shields.io/github/actions/workflow/status/MonsieurBarti/tff-pi/ci.yml?label=CI&style=flat-square" alt="CI Status">
    </a>
    <a href="https://www.npmjs.com/package/@the-forge-flow/tff-pi">
      <img src="https://img.shields.io/npm/v/@the-forge-flow/tff-pi?style=flat-square" alt="npm version">
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/github/license/MonsieurBarti/tff-pi?style=flat-square" alt="License">
    </a>
  </p>
</div>

---

## ✨ Features

- **📦 Ready-to-use structure**: Proper project layout following TFF conventions
- **🔧 TypeScript**: ES2022 target with strict mode
- **🎨 Biome**: Fast linting and formatting
- **🧪 Vitest**: Testing framework pre-configured
- **🪝 Git hooks**: Lefthook + commitlint for conventional commits
- **🚀 CI/CD**: GitHub Actions workflows included
- **📦 Release Please**: Automated versioning and npm publishing

## 📦 Installation

### As a Template

1. Clone this repository
2. Update `package.json` with your extension's name
3. Implement your tools in `src/`
4. Update this README

### Install in PI

PI discovers the extension automatically once installed as a pi package.

**From npm:**

```bash
pi install npm:@the-forge-flow/tff-pi
```

**From GitHub:**

```bash
pi install git:github.com/MonsieurBarti/tff-pi
```

Then reload PI with `/reload`.

## 🚀 Usage

The template includes an example tool and commands:

### Tool

```typescript
tff-example({
  action: "list" | "create" | "delete",
  input?: "string"  // For create action
})
```

### Commands

- `/tff-status` — Show extension status
- `/tff-toggle` — Toggle extension on/off

## 🧪 Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Lint & format
bun run lint

# Type check
bun run typecheck

# Build for publish
bun run build
```

## 📁 Project Structure

```
src/
├── index.ts              # Extension entry point
└── types.ts              # Type definitions
tests/
└── unit/                 # Unit tests
.github/workflows/
├── ci.yml                # CI pipeline
└── release.yml           # Release automation
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit with conventional commits (`git commit -m "feat: add something"`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## 📜 License

MIT © [MonsieurBarti](https://github.com/MonsieurBarti)

---

<div align="center">
  <sub>Built with ⚡ by <a href="https://github.com/MonsieurBarti">MonsieurBarti</a></sub>
</div>
