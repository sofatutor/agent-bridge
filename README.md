# Agent Bridge

A CLI tool that syncs AI agent configurations (skills, agents, prompts, ...etc.) from shared sources into your project's IDE directories (`.github/`, `.cursor/`, `.claude/`, ..etc.).

### Why Agent Bridge?

As teams adopt AI-powered IDEs, agent instructions quickly scatter across projects with no shared structure. Agent Bridge solves this by letting you **centralize and distribute** AI agent features across any number of projects, teams, and repositories.

- **Convention over configuration** — features are discovered from the filesystem automatically. No manifests, no mapping files — just organize by domain and feature type.
- **IDE-agnostic, IDE-aware** — syncs to all configured tools by default, while the `<tool>--` prefix convention lets you target features to specific IDEs (VS Code, Cursor, Claude Code, or custom tools) when needed.
- **Future-proof** — not limited to skills, agents, prompts, or instructions. Any new feature type that IDEs introduce is automatically supported — just add a folder to your source.
- **Multiple sources** — pull from any combination of Git repositories (HTTPS/SSH) and local paths. Mix company-wide standards with team-specific or project-specific sources.
- **Multi-domain organization** — structure features by domain (`backend`, `frontend`, `shared`, or your own) so each project pulls only what it needs.
- **Symlink-based, non-destructive** — IDE folders contain only symlinks managed by Agent Bridge. Existing files and directories are **never** touched, modified, or deleted.

## Features

- **Multi-source** — pull from multiple Git repositories (HTTPS/SSH) and local paths
- **Domain-based organization** — organize features by domain (`backend`, `frontend`, `shared`)
- **Tool-specific routing** — use the `<tool>--` prefix convention to target features to specific IDEs
- **Symlink-based** — no file duplication; your IDE folders contain symlinks to source features
- **Convention over configuration** — features are discovered from the filesystem, no manifest needed

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

Fetches remote sources, discovers features, and creates symlinks in your IDE folders.

Run this whenever:
- A source repository has new or changed features.
- You add, rename, or remove sources in `config.yml`.
- You change tool or domain configuration.

### 3. Update

```bash
agent-bridge update
```

Pulls the latest changes from all remote sources. Local sources require no update.

After updating, run `agent-bridge sync` to reconcile symlinks.

## Configuration

The config lives at `.agent-bridge/config.yml`:

```yaml
domains: [backend, frontend, shared]

tools:
  - name: vscode
    folder: .github
  - name: cursor
    folder: .cursor
  - name: claude
    folder: .claude

sources:
  # Git over HTTPS
  - name: remote-source
    source: https://github.com/sofatutor/agent-hub.git
    branch: main

  # Git over SSH
  - name: remote-source-ssh
    source: git@github.com:sofatutor/agent-hub.git
    branch: main

  # Local path (read directly, not cloned)
  - name: local-source
    source: /absolute/path/to/local/repo
```

### Fields

| Field              | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `domains`          | List of domain folders to scan in each source (e.g. `backend`, `frontend`, `shared`)              |
| `tools`            | IDE/tool declarations. `name` is used for prefix matching, `folder` is where symlinks are created |
| `sources`          | Where to pull features from. Can be Git repos (HTTPS, SSH) or local filesystem paths              |
| `sources[].branch` | Git branch to clone/track (remote sources only)                                                   |

## Source Types

| Type           | Example                           | Behavior                                             |
| -------------- | --------------------------------- | ---------------------------------------------------- |
| **HTTPS Git**  | `https://github.com/org/repo.git` | Cloned into `.agent-bridge/<name>/`, fetched on sync |
| **SSH Git**    | `git@github.com:org/repo.git`     | Cloned into `.agent-bridge/<name>/`, fetched on sync |
| **Local path** | `/absolute/path/to/repo`          | Read directly from the path (not cloned)             |

> **Note:** Local source paths must be absolute in `config.yml`. If you enter a
> relative path during `agent-bridge init`, it will be resolved to absolute
> automatically.

## Symlink Strategy

Symlinks created by agent-bridge use **relative targets** on disk (e.g.
`../../../local-source/shared/skills/foundation`), even though the config stores
absolute paths. This is intentional:

- **Portable** — the project directory can be moved without breaking symlinks.
- **Works across machines** — different users and CI environments have different
  absolute paths; relative symlinks remain valid as long as the project tree
  structure is intact.
- **Git-friendly** — Git stores symlink targets as-is; relative targets are
  consistent across clones.

This is the same pattern used by tools like `npm link` and `pnpm`. If sources
change location, simply update `config.yml` and re-run `agent-bridge sync`.

## Source Directory Structure

Each source is expected to contain domain folders, each with feature type folders:

```
<source>/
  shared/
    skills/
      foundation/
        SKILL.md
    agents/
      helper/
        AGENT.md
    cursor--instructions/     # Tool-specific feature type (Cursor only)
      my-rule/
  backend/
    skills/
      deploy/
        SKILL.md
```

## Tool-Specific Prefix Convention

Features and feature types can be scoped to a specific tool using the `<tool>--` prefix:

| Source path                            | Synced to    | Symlink name           |
| -------------------------------------- | ------------ | ---------------------- |
| `shared/skills/foundation/`            | All tools    | `skills/foundation`    |
| `shared/cursor--instructions/my-rule/` | Cursor only  | `instructions/my-rule` |
| `shared/vscode--prompts/my-prompt/`    | VS Code only | `prompts/my-prompt`    |
| `backend/skills/cursor--code-review/`  | Cursor only  | `skills/code-review`   |

Rules:
1. The separator is a **double dash** (`--`)
2. The prefix is **stripped** from the symlink name
3. Features **without** a prefix sync to **all** tools
4. Works at both the feature type level and the feature level

## CLI Commands

| Command               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `agent-bridge init`   | Interactive setup — creates `.agent-bridge/config.yml` |
| `agent-bridge sync`   | Fetch sources, discover features, reconcile symlinks   |
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

## How It Works

After running `agent-bridge sync`, your project looks like:

```
my-project/
├── .agent-bridge/
│   ├── config.yml                # Your configuration
│   ├── .gitignore                # Ignores cloned source dirs
│   └── company-hub/              # Cloned remote source
│       └── shared/skills/…
│
├── .github/                      # VS Code
│   ├── skills/
│   │   ├── foundation → ../../.agent-bridge/company-hub/shared/skills/foundation
│   │   └── deploy → ../../.agent-bridge/company-hub/backend/skills/deploy
│   └── prompts/
│       └── my-prompt → …
│
├── .cursor/                      # Cursor
│   ├── skills/
│   │   └── foundation → …
│   └── instructions/             # cursor--instructions → instructions
│       └── my-rule → …
│
└── .claude/                      # Claude
    └── skills/
        └── foundation → …
```

## Cleanup Behavior

When features are removed from a source and you re-run `agent-bridge sync`:

- Orphaned symlinks are detected and removed automatically.
- Empty parent directories left behind (e.g. `.github/agents/` after all agents are removed) are cleaned up.
- Real files and directories are **never** deleted — only symlinks managed by agent-bridge are touched.

## .gitignore

The `.agent-bridge/.gitignore` is auto-generated to ignore cloned sources while keeping `config.yml` tracked:

```gitignore
*
!config.yml
!.gitignore
```

## Authoring Features

Features live inside source repositories organized by domain and feature type:

1. Create a directory under `<domain>/<feature-type>/<feature-name>/` in a source repo.
2. Add your files inside it (e.g. `SKILL.md`, `AGENT.md`).
3. Run `agent-bridge sync` in each host repo to pick up the new feature.

Feature names must be unique across all sources (after tool-prefix stripping). Duplicates cause sync to halt with an error.

## Troubleshooting

| Symptom                           | Fix                                                                  |
| --------------------------------- | -------------------------------------------------------------------- |
| `config.yml not found`            | Run `agent-bridge init` from the repo root                           |
| Symlinks point to missing targets | Run `agent-bridge sync` to reconcile                                 |
| Source clone failed               | Check the Git URL and your SSH/HTTPS credentials                     |
| Duplicate feature name error      | Rename one of the conflicting features across sources                |
| Local source path not found       | Verify the path in `config.yml` is correct relative to the repo root |

## Development

```bash
npm install
npm run build       # Package the CLI with Vite+
npm test            # Run all tests
npm run test:watch  # Watch mode
```
