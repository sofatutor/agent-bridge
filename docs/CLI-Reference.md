# CLI Reference

All commands accept `--cwd <path>` to run against another directory. Default: the Git root, or the current directory outside Git.

## `agent-bridge init`

Interactive setup. Order of questions:

1. **Tools** — multiselect: VS Code (`.github`), Cursor (`.cursor`), Claude (`.claude`), Pi (`.pi`), or custom `name` + `folder`.
2. **Sources** — Git URL or local path, optional branch. Add as many as you like.
3. Sources are fetched.
4. **What to sync** — one checkbox tree: source → domain → feature type → feature, plus a `files` group per domain.

   ```
   ◆  What do you want to sync?
   │  ▾ ◧ ai-hub
   │    ▸ ◼ sofatutor-shared (9 skills)
   │    ▾ ◧ sofatutor-main (7 skills, 2 vscode--agents)
   │      ▸ ◧ skills (7)
   │      ▸ ◼ vscode--agents (2)
   │    ▸ ◻ sofatutor-kids (10 skills)
   └  space toggle · ←/→ collapse/expand · enter confirm
   ```

   Space ticks the node under the cursor and everything beneath it; a fully ticked domain is stored as "everything", partial picks become an `include` list. `→` opens a node, `←` closes it (or jumps to the parent).
5. **Git hooks?** — install `post-checkout` / `post-merge` hooks that run `sync` in the background.
6. **Run sync now?** — Yes by default.

Re-running `init` overwrites the existing config. If a source has no domains selected it is dropped.

### Non-interactive

Pass both `--tools` and `--source` to skip every prompt.

| Option               | Description                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `--tools <list>`     | Comma-separated: `cursor`, `vscode`, `claude`, `pi`, or `name:folder` for custom tools |
| `-s, --source <url>` | Repeatable. Git URL or path; append `#branch` to pin a branch                        |
| `--domains <list>`   | Comma-separated domains, applied to every source. Default: every domain found        |
| `--hooks`            | Install git hooks without asking                                                     |
| `--force`            | Overwrite foreign git hooks; also clears an opt-out tombstone                        |

```bash
agent-bridge init \
  --tools cursor,claude,windsurf:.windsurf \
  --source https://github.com/sofatutor/ai-hub.git#main \
  --source /abs/path/to/local-hub \
  --domains sofatutor-shared \
  --hooks
```

Per-domain `include` lists are not available as flags; edit `config.yml` (see [Configuration](Configuration.md)).

## `agent-bridge sync`

1. Runs pending config migrations.
2. Clones new remote sources, pulls existing ones (`--ff-only`), removes clones for sources no longer in config.
3. Scans domains → feature types → features, honoring `include`.
4. Stops on duplicates or on a destination that exists but isn't managed by Agent Bridge.
5. Adds, updates and removes features, root files and tool root files. Prints counts.

Exit code is non-zero on any error, so it's safe in CI.

> `agent-bridge update` (pre-0.14) is a hidden alias that runs `sync`. Hooks installed by older versions keep working; the first `sync` rewrites them to call `sync` only.

## `agent-bridge opt-out`

Removes Agent Bridge from the current repo without prompts:

- deletes every feature and tool root file tracked in `.agentbridge` manifests
- removes Agent Bridge git hooks (foreign hooks are kept)
- deletes `.agent-bridge/` (config and clones)
- writes a `.agent-bridge/optout` tombstone

Root files (`AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`) are left in place.

While the tombstone exists, `init` and `sync` are no-ops (exit 0). It is gitignored, so opting out is per machine; `git add -f .agent-bridge/optout` makes it repo-wide. Re-enable with `agent-bridge init --force` or by deleting the file.

## Git hooks

`init` can install `post-checkout` and `post-merge` hooks. They run `agent-bridge sync` (falling back to `npx @sofatutor/agent-bridge sync`) in the background after a one-second delay and log to `.agent-bridge/hook.log` (trimmed to 200 lines).

- Hooks are marked with `# agent-bridge-hook` so Agent Bridge only ever overwrites its own.
- Existing foreign hooks are skipped. Use `--force` to replace them, or add this to your hook:

  ```sh
  ( sleep 1; agent-bridge sync ) >/dev/null 2>&1 &
  ```

- Remove them with `agent-bridge opt-out` or `rm .git/hooks/post-checkout .git/hooks/post-merge`.

## `postinstall` pattern

```json
"postinstall": "test -d .agent-bridge || (npx @sofatutor/agent-bridge init --tools claude --source https://github.com/org/hub.git --hooks && npx @sofatutor/agent-bridge sync) || true"
```

`opt-out` keeps `.agent-bridge/` (holding only the tombstone), so the guard stays false after opting out and nothing is reinstalled.
