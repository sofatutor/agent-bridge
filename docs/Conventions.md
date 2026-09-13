# Conventions

A source needs no manifest. Agent Bridge reads its folder layout.

## Layout

```
<source>/
  <domain>/
    <feature-type>/
      <feature>/            ← folder feature (e.g. skills/deploy/SKILL.md)
      <feature>.md          ← or a single-file feature
    AGENTS.md               ← root file → copied to the project root
    cursor--settings.json   ← tool root file → copied to .cursor/settings.json
```

Real example ([sofatutor/ai-hub](https://github.com/sofatutor/ai-hub)):

```
ai-hub/
  sofatutor-shared/
    skills/
      code-review/SKILL.md
      circleci/SKILL.md
  sofatutor-main/
    skills/preview/SKILL.md
    vscode--agents/review.agent.md
  sofatutor-kids/
    pi--settings.json
    skills/rails-backend/SKILL.md
```

- **Domain** — any top-level folder. Group by project, platform, team, or "shared". Hidden folders and `node_modules` are ignored.
- **Feature type** — any folder inside a domain: `skills`, `agents`, `prompts`, `instructions`, … Whatever your tools understand. New types need no code change.
- **Feature** — a folder or a single file inside a feature type. Synced to `<tool-folder>/<feature-type>/<feature>`.

## Tool routing with `<tool>--`

Prefix a feature type or a single feature with a tool name and a double dash to send it to that tool only. The prefix is stripped on the way.

| Source path                              | Goes to      | Lands at               |
| ---------------------------------------- | ------------ | ---------------------- |
| `shared/skills/foundation/`              | all tools    | `skills/foundation`    |
| `shared/cursor--instructions/my-rule/`   | Cursor only  | `instructions/my-rule` |
| `shared/vscode--prompts/my-prompt/`      | VS Code only | `prompts/my-prompt`    |
| `backend/skills/cursor--code-review/`    | Cursor only  | `skills/code-review`   |

The tool name must match a `tools[].name` in the project's config. Unknown prefixes are ignored.

## Root files

`AGENTS.md`, `CLAUDE.md` and `SYSTEM.md` placed directly in a domain are copied to the **project root**.

- A `<!-- Managed by Agent Bridge -->` marker is prepended. Files without the marker are yours and are never touched.
- Only one source × domain may provide each root file; duplicates stop the sync.
- Removing the file from the source removes the managed copy.

## Tool root files

A flat file in a domain named `<tool>--<file>` is copied into that tool's folder root: `cursor--settings.json` → `.cursor/settings.json`. Tracked in `.cursor/.agentbridge`. Same uniqueness rule as root files, per tool.

## Naming rules

- Feature names must be unique across all sources and domains **after** the prefix is stripped. Duplicates stop the sync with a clear error.
- Names may use `A-Z a-z 0-9 . _ -`.
- Symlinks inside features are skipped.

## Authoring a new feature

1. Create `<domain>/<feature-type>/<feature-name>/` in the source repo and add files (`SKILL.md`, `AGENT.md`, …).
2. Push.
3. Run `agent-bridge sync` in each project. Projects with an `include` list only pick it up if the feature type or feature is listed; re-run `init` to reselect.
