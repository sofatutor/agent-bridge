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

## Authoring Features

Features live inside source repositories organized by domain and feature type:

1. Create a directory under `<domain>/<feature-type>/<feature-name>/` in a source repo.
2. Add your files inside it (e.g. `SKILL.md`, `AGENT.md`).
3. Run `agent-bridge sync` in each host repo to pick up the new feature.

Feature names must be unique across all sources (after tool-prefix stripping). Duplicates cause sync to halt with an error.
