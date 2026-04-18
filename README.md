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
7. Optionally install git hooks to auto-sync on checkout/merge.

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

## Git Hooks (Auto-Sync)

When running `agent-bridge init` inside a Git repository, you'll be prompted to install git hooks that automatically keep your AI agent configurations up to date. If enabled, Agent Bridge installs:

- **post-checkout** — runs after `git checkout` (switching branches)
- **post-merge** — runs after `git merge` or `git pull`

These hooks run `agent-bridge update && agent-bridge sync` in the background, so your workflow isn't blocked.

### How It Works

The hooks execute asynchronously with a short delay to let Git complete its operations. They:
1. Check if `agent-bridge` is available globally
2. Fall back to `npx @sofatutor/agent-bridge` if not
3. Run update and sync silently in the background

### Skipping Existing Hooks

If you already have custom `post-checkout` or `post-merge` hooks, Agent Bridge will skip them to avoid conflicts. You can manually integrate Agent Bridge into your existing hooks by adding:

```sh
# At the end of your existing hook
(
  sleep 1
  agent-bridge update && agent-bridge sync
) >/dev/null 2>&1 &
```

### Removing Hooks

Agent Bridge marks its hooks with a special comment. To remove them, delete the hook files:

```bash
rm .git/hooks/post-checkout .git/hooks/post-merge
```

Or re-run `agent-bridge init` — Agent Bridge hooks are automatically updated on re-init.

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
| Git hooks not installed      | Run `agent-bridge init` from inside a Git repository                 |
| Hooks skipped (existing)     | Existing non-Agent-Bridge hooks are preserved; integrate manually    |

## Development

```bash
npm install
npm run build       # Package the CLI with Vite+
npm test            # Run all tests
npm run test:watch  # Watch mode
```
