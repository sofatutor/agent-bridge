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
├── AGENTS.md                     # Root file (managed by Agent Bridge)
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
│   ├── instructions/             # cursor--instructions → instructions
│   │   └── my-rule/
│   │       ├── .agentbridge
│   │       └── instructions.md
│   ├─ .agentbridge              # Manifest for tool root files
│   └─ settings.json             # From cursor--settings.json
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

## Opt-out Behavior

Running `agent-bridge opt-out` performs a non-interactive cleanup for the current repository:

- Removes entries tracked in `.agentbridge` manifests (feature and tool-root entries)
- Removes Agent Bridge-managed git hooks (`post-checkout`, `post-merge`)
- Deletes `.agent-bridge/` (config and cloned sources)
- Writes a `.agent-bridge.optout` tombstone at the repo root

`opt-out` intentionally does not remove root files (`AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`) even when they carry the managed marker.

### The opt-out tombstone

Deleting `.agent-bridge/` alone is not durable: a `postinstall` guard such as `test -d .agent-bridge || (init && sync)` would treat the missing directory as "not installed" and reinstall on the next `npm install`. The `.agent-bridge.optout` marker breaks that loop:

- While it exists, `agent-bridge init` and `agent-bridge sync` are no-ops (they log and exit 0).
- `agent-bridge init --force` deletes the marker and re-initializes (deliberate re-opt-in).
- Commit the marker for a repo-wide opt-out; gitignore it to keep opt-out local to a single machine.

## Root Files

Root files (`AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`) placed at the domain root in a source are
copied directly to the workspace root during sync:

```
my-project/
├── AGENTS.md                 ← Copied from source (managed by Agent Bridge)
├── CLAUDE.md                 ← Copied from source (managed by Agent Bridge)
├── .agent-bridge/
│   └── config.yml
├── .github/
│   └── skills/
│       └── foundation/
│           ├── .agentbridge
│           └── SKILL.md
└── …
```

Managed root files are prefixed with a `<!-- Managed by Agent Bridge -->` marker
on the first line. This marker serves the same purpose as the `.agentbridge`
file does for feature folders:

- **Re-sync safe** — managed root files are overwritten with the latest source
  content on every sync.
- **User file safety** — if a root file exists without the marker, it is treated
  as user-created and never touched.
- **Clean removal** — when a source no longer provides a root file, the managed
  copy is deleted.
- **Duplicate detection** — if the same root file is provided by multiple
  sources or domains, sync aborts with an error.

## Tool Root Files

Tool root files (flat files with a `<toolname>--` prefix at the domain level)
are synced directly into the tool's root folder. They are tracked in the
`.agentbridge` manifest file at the tool root level (e.g. `.cursor/.agentbridge`):

- **Re-sync safe** — files tracked in the manifest are updated in place on
  subsequent syncs.
- **Conflict detection** — if the same destination filename is provided for the
  same tool by multiple sources or domains, sync aborts with an error.
- **Clean removal** — when files are removed from the source, managed files
  (those in the manifest) are deleted.
- **Coexistence** — tool root files share the `.agentbridge` manifest with
  regular features synced to the same tool folder.

## .gitignore

The `.agent-bridge/.gitignore` is auto-generated to ignore cloned sources while keeping `config.yml` tracked:

```gitignore
*
!config.yml
!.gitignore
```
