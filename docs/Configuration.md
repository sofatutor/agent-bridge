# Configuration

Everything lives in one committed file: `.agent-bridge/config.yml`.

```yaml
version: 0.14.0

tools:
  - name: vscode
    folder: .github
  - name: cursor
    folder: .cursor
  - name: claude
    folder: .claude

sources:
  - name: ai-hub
    source: https://github.com/sofatutor/ai-hub.git
    branch: main
    domains:
      - name: sofatutor-shared         # everything in this domain
      - name: sofatutor-main           # only the listed paths
        include:
          - skills/preview             # one feature
          - vscode--agents             # a whole feature type
          - AGENTS.md                  # a flat file at the domain root

  - name: local-experiments
    source: /absolute/path/to/folder   # local folders are read in place
    domains:
      - name: playground
```

## Fields

| Field                        | Description                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `version`                    | Agent Bridge version that last wrote the file. Maintained automatically by `sync`.            |
| `tools[].name`               | Tool name. Used for `<name>--` prefix routing. Must not contain `--`.                         |
| `tools[].folder`             | Where features land, relative to the repo root (e.g. `.cursor`).                              |
| `sources[].name`             | Short unique name. Remote sources are cloned to `.agent-bridge/<name>/`.                      |
| `sources[].source`           | Git URL (HTTPS/SSH) or **absolute** local path.                                               |
| `sources[].branch`           | Branch to track. Remote sources only. Omit for the remote default.                            |
| `sources[].domains[].name`   | Domain folder to sync from this source. A bare string is accepted as shorthand for `name`.   |
| `sources[].domains[].include`| Paths inside the domain to sync. Omit to sync the whole domain. See below.                    |

## `include` paths

Each entry is a path relative to the domain root, one or two segments deep:

| Entry             | Syncs                                              |
| ----------------- | -------------------------------------------------- |
| `skills`          | every feature in `<domain>/skills/`                 |
| `skills/preview`  | just `<domain>/skills/preview` (folder or file)     |
| `AGENTS.md`       | the root file `<domain>/AGENTS.md`                  |
| `pi--settings.json` | the tool root file `<domain>/pi--settings.json`   |

No `include` = the whole domain. An empty domain folder or a path that doesn't exist is silently skipped.

`agent-bridge init` writes `include` for you when you deselect items; it collapses fully selected feature types to one entry (`skills`) to keep the file short.

## Source types

| Type           | Example                            | Behavior                                              |
| -------------- | ---------------------------------- | ----------------------------------------------------- |
| **HTTPS Git**  | `https://github.com/org/repo.git`  | Shallow-cloned into `.agent-bridge/<name>/`, pulled on every `sync` |
| **SSH Git**    | `git@github.com:org/repo.git`      | Same as HTTPS                                          |
| **Local path** | `/absolute/path/to/repo`           | Read directly. Must be absolute (`init` resolves relative input for you) |

## Top-level `domains` (compatibility)

You will also see a top-level list in every file Agent Bridge writes:

```yaml
domains: [agent-dna, sofatutor-shared, sofatutor-main]
```

It is the union of all `sources[].domains` names and is regenerated on every save. Agent Bridge ≤ 0.13 requires it (and ignores the per-source lists), so teammates who haven't upgraded yet keep working during a rollout: they sync those whole domains, without `include` filtering. Newer versions only use it as a fallback for a source that has no `domains` of its own. You don't need to maintain it by hand.

## Version & migrations

`sync` compares `version` with the installed package. When the package is newer, it runs any pending migrations in order, then bumps `version`. Most upgrades have no migration and only the field changes.

Migrations live in `src/lib/migrations/index.ts`:

```ts
{
  version: '0.14.0',
  description: 'move top-level domains into each source',
  migrate: async (repoRoot, config) => ({ ...config /* transformed */ }),
}
```

A migration runs once, only for configs older than its target version.
