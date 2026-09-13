# Agent Bridge

Sync AI agent skills, agents, prompts and instructions from a shared repo into your project's tool folders (`.github/`, `.cursor/`, `.claude/`, …).

One source of truth. Every project. Every tool.

## Quick start

```bash
npx @sofatutor/agent-bridge init
```

That's it. The wizard walks you through three questions:

1. **Tools** — VS Code, Cursor, Claude, Pi, or a custom folder.
2. **Sources** — a Git URL (or local path) that holds your shared skills, e.g. `https://github.com/sofatutor/ai-hub.git`.
3. **What to sync** — a tree of every domain in each source. Tick a domain to take all of it, or open it and tick single skills, agents or files.

It saves `.agent-bridge/config.yml`, offers to install git hooks, and syncs immediately.

Then commit the config:

```bash
git add .agent-bridge/config.yml && git commit -m "chore: add agent-bridge config"
```

Change your selection later with `agent-bridge init` → **Change what to sync**. Pull the latest features any time:

```bash
npx @sofatutor/agent-bridge sync
```

### Install for keeps

```bash
npm install -g @sofatutor/agent-bridge        # global
npm install --save-dev @sofatutor/agent-bridge # per project
```

### Scripted setup (CI, postinstall)

```bash
agent-bridge init \
  --tools cursor,vscode,claude \
  --source https://github.com/sofatutor/ai-hub.git#main \
  --domains sofatutor-shared,sofatutor-main \
  --hooks
agent-bridge sync
```

Omit `--domains` to take every domain in the source.

## What you get

```
my-project/
├── .agent-bridge/config.yml     ← the only file you commit
├── .github/skills/code-review/  ← synced (VS Code)
├── .cursor/skills/code-review/  ← synced (Cursor)
└── .claude/skills/code-review/  ← synced (Claude)
```

- **Convention over configuration** — a source is just folders: `<domain>/<feature-type>/<feature>/`. No manifests.
- **Pick what you need** — whole domains, or individual skills, agents and files per domain.
- **Tool-aware** — `cursor--rules/` goes to Cursor only; everything else goes to every tool.
- **Non-destructive** — Agent Bridge only ever touches files it created. Your own skills are safe.
- **Stays fresh** — `sync` fetches sources and reconciles; git hooks can do it for you after checkout/merge.

## Commands

| Command                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `agent-bridge init`     | Interactive setup (or scripted with `--tools`/`--source`)       |
| `agent-bridge sync`     | Fetch sources and sync features into your tool folders          |
| `agent-bridge opt-out`  | Remove everything Agent Bridge created from this repo           |

All commands accept `--cwd <path>`.

> `agent-bridge update` was merged into `sync` in 0.14. The old command still works and simply runs `sync`.

## Config at a glance

```yaml
tools:
  - name: claude
    folder: .claude
sources:
  - name: ai-hub
    source: https://github.com/sofatutor/ai-hub.git
    branch: main
    domains:
      - name: sofatutor-shared       # everything in this domain
      - name: sofatutor-main         # only these bits
        include:
          - skills/preview
          - vscode--agents
          - AGENTS.md
```

Full reference: [Configuration](docs/Configuration.md).

## Docs

| Page                                        | Read it when…                                        |
| ------------------------------------------- | ---------------------------------------------------- |
| [Configuration](docs/Configuration.md)      | you want to edit `config.yml` by hand                |
| [Conventions](docs/Conventions.md)          | you're authoring a source repo (like `ai-hub`)       |
| [CLI Reference](docs/CLI-Reference.md)      | you need every flag, plus git hooks and opt-out      |
| [Sync Strategy](docs/Sync-Strategy.md)      | you wonder what sync touches and what it never does  |
| [Upgrading](docs/Upgrading.md)              | you're coming from 0.13 or earlier                   |
| [Troubleshooting](docs/Troubleshooting.md)  | something's off                                      |

The same pages are published to the [GitHub wiki](https://github.com/sofatutor/agent-bridge/wiki).

## Development

```bash
npm install
npm run check   # typecheck + tests
npm run build   # bundle the CLI into dist/
```

Requires Node ≥ 18 and Git (for remote sources).
