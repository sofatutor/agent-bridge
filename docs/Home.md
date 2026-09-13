# Agent Bridge

Sync AI agent skills, agents, prompts and instructions from a shared repo into your project's tool folders (`.github/`, `.cursor/`, `.claude/`, …).

## Start here

```bash
npx @sofatutor/agent-bridge init
```

The wizard asks for **tools**, **sources**, then shows the **domains** inside each source so you can tick what you want. It saves `.agent-bridge/config.yml` and runs the first sync. Commit the config; run `agent-bridge sync` whenever you want the latest.

## Pages

| Page                                 | Read it when…                                        |
| ------------------------------------ | ---------------------------------------------------- |
| [Configuration](Configuration.md)    | you want to edit `config.yml` by hand                |
| [Conventions](Conventions.md)        | you're authoring a source repo (like `ai-hub`)       |
| [CLI Reference](CLI-Reference.md)    | you need every flag, plus git hooks and opt-out      |
| [Sync Strategy](Sync-Strategy.md)    | you wonder what sync touches and what it never does  |
| [Upgrading](Upgrading.md)            | you're coming from 0.13 or earlier                   |
| [Troubleshooting](Troubleshooting.md)| something's off                                      |

## How it fits together

```
 ai-hub (source repo)                    my-project
 ├── sofatutor-shared/                   ├── .agent-bridge/config.yml
 │   └── skills/code-review/   ──sync──▶ ├── .github/skills/code-review/
 └── sofatutor-main/                     ├── .cursor/skills/code-review/
     └── vscode--agents/       ──sync──▶ └── .github/agents/
```

- A **source** is any Git repo or folder laid out as `<domain>/<feature-type>/<feature>/`.
- A **domain** groups features for a project, platform or team.
- A **feature type** (`skills`, `agents`, `prompts`, …) maps 1:1 to a folder inside each tool directory.
- `<tool>--` prefixes route a feature type or feature to one tool only.

These pages are mirrored from the [`docs/` folder](https://github.com/sofatutor/agent-bridge/tree/main/docs) of the repository. Edit them there.
