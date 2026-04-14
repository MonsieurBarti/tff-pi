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

## 🏠 Project Home

TFF stores all live project state under `~/.tff/{projectId}/` on your machine. Your repository carries two things:

- **`.tff-project-id`** (tracked) — a single-line UUID that anchors your repo to its project home.
- **`.tff/`** (gitignored) — a symlink pointing to `~/.tff/{projectId}/`. All TFF paths like `.tff/state.db`, `.tff/milestones/…`, `.tff/settings.yaml` resolve through this symlink.

This means your working tree stays clean: no database, no logs, no session locks in the repo.

### Initializing a project

```bash
/tff init
```

Bootstraps the project home, creates the symlink, writes `.tff-project-id`, and stages both `.tff-project-id` and `.gitignore` for you to commit. Idempotent — safe to re-run.

`/tff new` runs this automatically on a fresh repo, so you rarely need to invoke `/tff init` directly unless you deleted the symlink or `~/.tff/{id}/` manually.

### `TFF_HOME` env variable

Override the `~/.tff/` root with `TFF_HOME`:

```bash
export TFF_HOME=/my/shared/tff-homes
```

Useful for tests, CI, or shared-disk environments.

### Recovering from a manually deleted project home

If you (or a sync tool) removed `~/.tff/{id}/`, run `/tff init` again. It keeps your existing `.tff-project-id`, re-creates the home dir, and re-runs DB migrations on a fresh state file. DB is fresh — any in-flight work was lost. Re-run `/tff new` to re-seed or restore from backup manually.

### Platform support

macOS and Linux. Windows support requires Developer Mode (for symlinks) and lands in M11.

### Multi-machine sync

Coming in M10-S03 (orphan state branches + JSON merge driver). M10-S01 is just the centralization foundation.

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
