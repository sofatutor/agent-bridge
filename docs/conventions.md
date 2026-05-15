# Conventions

Agent Bridge uses filesystem conventions to discover and route features — no manifests or mapping files needed.

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

| Source path                            | Synced to    | Folder name            |
| -------------------------------------- | ------------ | ---------------------- |
| `shared/skills/foundation/`            | All tools    | `skills/foundation`    |
| `shared/cursor--instructions/my-rule/` | Cursor only  | `instructions/my-rule` |
| `shared/vscode--prompts/my-prompt/`    | VS Code only | `prompts/my-prompt`    |
| `backend/skills/cursor--code-review/`  | Cursor only  | `skills/code-review`   |

Rules:

1. The separator is a **double dash** (`--`)
2. The prefix is **stripped** from the folder name
3. Features **without** a prefix sync to **all** tools
4. Works at both the feature type level and the feature level

## Root Files

Certain well-known files placed at the **domain root** (not inside a feature-type folder) are treated as **root files** and copied directly to the workspace root:

| File        | Purpose                                        |
| ----------- | ---------------------------------------------- |
| `AGENTS.md` | Always-on agent instructions (VS Code, Cursor) |
| `CLAUDE.md` | Always-on instructions for Claude Code         |
| `SYSTEM.md` | Custom system prompt for Pi                    |

Example source layout:

```
<source>/
  shared/
    AGENTS.md             ← root file → copied to <project>/AGENTS.md
    CLAUDE.md             ← root file → copied to <project>/CLAUDE.md
    SYSTEM.md             ← root file → copied to <project>/SYSTEM.md
    skills/
      foundation/
        SKILL.md
```

Rules:

1. Root files must be **unique** across all sources × domains. If two domains both provide `AGENTS.md`, sync halts with an error.
2. A `<!-- Managed by Agent Bridge -->` marker is prepended when copied. Files without this marker are treated as user-created and **never** overwritten.
3. When a root file is removed from the source, the managed copy at the workspace root is deleted automatically.

## Tool Root Files (Tool-Prefixed Flat Files)

Flat files at the domain level with a `<toolname>--` prefix are **tool root files**. They are synced directly into the tool's root folder (e.g. `.cursor/`, `.pi/`), bypassing the normal feature-type routing.

This reuses the existing `--` prefix convention and is useful for syncing arbitrary configuration files that a tool expects at specific paths inside its root directory.

```
<source>/
  shared/
    cursor--settings.json   ← synced to <project>/.cursor/settings.json
    pi--config.json         ← synced to <project>/.pi/config.json
    skills/
      foundation/
        SKILL.md
```

Rules:

1. The tool name before `--` must match a configured tool name (e.g. `cursor--settings.json` matches `{ name: 'cursor', folder: '.cursor' }`).
2. Files with an unrecognized tool prefix (where the name doesn't match any configured tool) are **ignored**.
3. Each tool root file is tracked in the tool root's `.agentbridge` manifest.
4. Entries must be **unique** across all sources × domains for the same tool. Duplicates cause sync to halt with an error.
5. Only flat files are supported — directories with a tool prefix at the domain level are treated as regular feature types.

## Authoring Features

Features live inside source repositories organized by domain and feature type:

1. Create a directory under `<domain>/<feature-type>/<feature-name>/` in a source repo.
2. Add your files inside it (e.g. `SKILL.md`, `AGENT.md`).
3. Run `agent-bridge sync` in each host repo to pick up the new feature.

Feature names must be unique across all sources (after tool-prefix stripping). Duplicates cause sync to halt with an error.
