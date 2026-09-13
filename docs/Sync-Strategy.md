# Sync Strategy

The rule: **Agent Bridge only touches what it created.**

## Manifests

Every feature-type folder that receives synced content gets one hidden file, `.agentbridge`, listing the entries Agent Bridge owns:

```
.github/skills/.agentbridge
  code-review/
  circleci/
  hello.prompt.md
```

Folders end with `/`, files don't. Tool root files are tracked the same way in `<tool-folder>/.agentbridge`.

- **Re-sync** — listed entries are replaced with fresh copies.
- **Conflict** — a destination that exists but isn't listed belongs to you. Sync stops and tells you the path.
- **Removal** — listed entries that are no longer expected (removed upstream, domain deselected, `include` narrowed, tool removed) are deleted. Empty parent folders are cleaned up.
- Nothing outside the manifest is ever deleted or modified.

## Project layout after sync

```
my-project/
├── AGENTS.md                      # root file (marker on line 1)
├── .agent-bridge/
│   ├── config.yml                 # committed
│   ├── .gitignore                 # ignores everything else here
│   └── ai-hub/                    # shallow clone of a remote source
├── .github/
│   ├── skills/
│   │   ├── .agentbridge
│   │   └── code-review/SKILL.md
│   └── agents/
│       ├── .agentbridge
│       └── review.agent.md        # from vscode--agents/
└── .cursor/
    ├── .agentbridge               # tool root files
    ├── settings.json              # from cursor--settings.json
    └── skills/
        ├── .agentbridge
        └── code-review/SKILL.md
```

## Root files

`AGENTS.md`, `CLAUDE.md`, `SYSTEM.md` are copied to the project root with `<!-- Managed by Agent Bridge -->` as the first line.

- Managed copies are overwritten on every sync and deleted when the source stops providing them.
- A root file **without** the marker is yours: skipped, never overwritten, never deleted.
- Two sources or domains providing the same root file stop the sync.
- `opt-out` deliberately leaves root files in place.

## Source clones

Remote sources are shallow clones in `.agent-bridge/<name>/`, each carrying an `.agent-bridge-managed` marker. `sync` fast-forwards them and switches branch when `branch` changes in config. Clones whose source left the config are removed, but only if they carry the marker (or a `.git` folder, for clones from before the marker existed).

`.agent-bridge/.gitignore` is regenerated on every run:

```gitignore
*
!config.yml
!.gitignore
```

## Guarantees in one table

| Situation                                  | Result                                     |
| ------------------------------------------ | ------------------------------------------ |
| Feature exists upstream, not yet locally   | copied, added to manifest                  |
| Feature changed upstream                   | replaced                                   |
| Feature removed upstream / deselected      | deleted, manifest updated                  |
| Local folder with the same name, no manifest entry | sync stops with a conflict error   |
| Same feature name from two sources         | sync stops with a duplicate error          |
| Root file without marker                   | untouched                                  |
| `opt-out`                                  | everything in manifests removed, root files kept |
