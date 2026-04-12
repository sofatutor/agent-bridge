# Sync Strategy

Agent Bridge copies source feature files into your tool folders and places a
`.agentbridge` marker file in each synced feature directory. This marker is how
Agent Bridge identifies folders it manages:

- **Re-sync safe** — on subsequent runs, folders with `.agentbridge` are
  recognized as previously synced and are updated in place.
- **Conflict detection** — if a destination folder exists without the marker,
  it's treated as a user-created directory and sync aborts with an error.
- **Clean removal** — when features are removed from a source, Agent Bridge
  deletes only the folders it previously created (those with the marker).

The `.agentbridge` file is a hidden zero-byte file that does not interfere with
tool behavior.

## Project Structure After Sync

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
│   │   ├── foundation/
│   │   │   ├── .agentbridge          # Marker (managed by Agent Bridge)
│   │   │   └── SKILL.md
│   │   └── deploy/
│   │       ├── .agentbridge
│   │       └── SKILL.md
│   └── prompts/
│       └── my-prompt/
│           ├── .agentbridge
│           └── prompt.md
│
├── .cursor/                      # Cursor
│   ├── skills/
│   │   └── foundation/
│   │       ├── .agentbridge
│   │       └── SKILL.md
│   └── instructions/             # cursor--instructions → instructions
│       └── my-rule/
│           ├── .agentbridge
│           └── instructions.md
│
└── .claude/                      # Claude
    └── skills/
        └── foundation/
            ├── .agentbridge
            └── SKILL.md
```

## Cleanup Behavior

When features are removed from a source and you re-run `agent-bridge sync`:

- Orphaned feature folders (those with a `.agentbridge` marker that are no longer expected) are detected and removed automatically.
- Empty parent directories left behind (e.g. `.github/agents/` after all agents are removed) are cleaned up.
- Real files and directories (those without a `.agentbridge` marker) are **never** deleted — only folders managed by Agent Bridge are touched.

## .gitignore

The `.agent-bridge/.gitignore` is auto-generated to ignore cloned sources while keeping `config.yml` tracked:

```gitignore
*
!config.yml
!.gitignore
```
