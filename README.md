# Agent Bridge

A CLI tool that syncs AI agent configurations (skills, agents, prompts, ...etc.) from shared sources into your project's tool directories (`.github/`, `.cursor/`, `.claude/`, ..etc.).

### Why Agent Bridge?

As teams adopt AI coding tools, agent instructions quickly scatter across projects with no shared structure. Agent Bridge solves this by letting you **centralize and distribute** AI agent features across any number of projects, teams, and repositories — using **conventions over configuration**, with no manifests or mapping files required.

- **Convention over configuration** — features are discovered from the filesystem automatically. No manifests, no mapping files — just organize by domain and feature type.
- **Tool-agnostic, tool-aware** — syncs to all configured tools by default, while the `<tool>--` prefix convention lets you target features to specific tools (VS Code, Cursor, Claude Code, or custom tools) when needed.
- **Extensible** — not limited to skills, agents, prompts, or instructions. Any new feature type that tools introduce is automatically supported — just add a folder to your source.
- **Multiple sources** — pull from any combination of Git repositories (HTTPS/SSH) and local paths. Mix company-wide standards with team-specific or project-specific sources.
- **Multi-domain organization** — structure features by domain (`backend`, `frontend`, `shared`, or your own) so each project pulls only what it needs.
- **Non-destructive** — previously defined skills, agents, prompts, and other tool files are **never** touched, modified, or deleted.

## Prerequisites

- Git (optional — needed only for remote sources)
- Node.js ≥ 18

## Installation

```bash
npm install -g @sofatutor/agent-bridge
```

Or install locally as a dev dependency:

```bash
npm install --save-dev @sofatutor/agent-bridge
```

Or run directly with `npx`:

```bash
npx @sofatutor/agent-bridge init
```

## Quick Start

### 1. Initialize

```bash
agent-bridge init
```

The interactive init flow will:
1. Ask which domains to use (e.g. `backend`, `frontend`, `shared`).
2. Ask which tools to configure — choose from well-known presets (VS Code, Cursor, Claude) or add custom tools.
3. Ask for sources — Git repos (HTTPS/SSH) or local paths, with optional branch.
4. Generate `.agent-bridge/config.yml`.
5. Clone any remote sources.
6. Create `.agent-bridge/.gitignore` (ignores cloned repos, keeps config).

After init, commit `.agent-bridge/config.yml` to your repo.

### 2. Sync

```bash
agent-bridge sync
```

Fetches remote sources, discovers features, and copies them into your tool folders.

Run this whenever:
- A source repository has new or changed features.
- You add, rename, or remove sources in `config.yml`.
- You change tool or domain configuration.

### 3. Update

```bash
agent-bridge update
```

Pulls the latest changes from all remote sources. Local sources require no update.

After updating, run `agent-bridge sync` to reconcile features.

## CLI Commands

| Command               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `agent-bridge init`   | Interactive setup — creates `.agent-bridge/config.yml` |
| `agent-bridge sync`   | Fetch sources, discover features, reconcile files      |
| `agent-bridge update` | Fetch latest changes for all remote sources            |

### Global Options

| Option         | Description                                                                              |
| -------------- | ---------------------------------------------------------------------------------------- |
| `--cwd <path>` | Override the working directory. Defaults to the Git root, or `cwd` if not in a Git repo. |

Examples:

```bash
# Run sync for a specific project in a monorepo
agent-bridge sync --cwd ./packages/api

# Point at a project outside the current directory
agent-bridge sync --cwd /path/to/my-project
```

## Documentation

- [Configuration](docs/configuration.md) — config file reference, fields, source types
- [Conventions](docs/conventions.md) — source directory structure, tool-prefix routing, authoring features
- [Sync Strategy](docs/sync-strategy.md) — marker files, project structure after sync, cleanup behavior

## Troubleshooting

| Symptom                      | Fix                                                                  |
| ---------------------------- | -------------------------------------------------------------------- |
| `config.yml not found`       | Run `agent-bridge init` from the repo root                           |
| Source clone failed          | Check the Git URL and your SSH/HTTPS credentials                     |
| Duplicate feature name error | Rename one of the conflicting features across sources                |
| Local source path not found  | Verify the path in `config.yml` is correct relative to the repo root |
| Path conflict error          | A non-managed folder exists at the destination — rename or remove it |

## Development

```bash
npm install
npm run build       # Package the CLI with Vite+
npm test            # Run all tests
npm run test:watch  # Watch mode
```
