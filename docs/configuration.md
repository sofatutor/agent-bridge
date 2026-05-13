# Configuration

The config lives at `.agent-bridge/config.yml`:

```yaml
version: 0.5.0

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

## Fields

| Field              | Description                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `version`          | The Agent Bridge version that last wrote this config. Updated automatically on `sync`/`update` |
| `domains`          | List of domain folders to scan in each source (e.g. `backend`, `frontend`, `shared`)         |
| `tools`            | Tool declarations. `name` is used for prefix matching, `folder` is where features are synced |
| `sources`          | Where to pull features from. Can be Git repos (HTTPS, SSH) or local filesystem paths         |
| `sources[].branch` | Git branch to clone/track (remote sources only)                                              |

## Source Types

| Type           | Example                           | Behavior                                             |
| -------------- | --------------------------------- | ---------------------------------------------------- |
| **HTTPS Git**  | `https://github.com/org/repo.git` | Cloned into `.agent-bridge/<name>/`, fetched on sync |
| **SSH Git**    | `git@github.com:org/repo.git`     | Cloned into `.agent-bridge/<name>/`, fetched on sync |
| **Local path** | `/absolute/path/to/repo`          | Read directly from the path (not cloned)             |

> **Note:** Local source paths must be absolute in `config.yml`. If you enter a
> relative path during `agent-bridge init`, it will be resolved to absolute
> automatically.

## Version & Migrations

The `version` field in `config.yml` tracks which Agent Bridge version last wrote the file. It is set during `init` and updated automatically whenever you run `sync` or `update`.

### Automatic version bump

When the installed package is newer than the config version, the config is updated silently. Most version bumps don't require any structural changes — the version field is simply set to the current version.

### Migration scripts

When a new version introduces breaking changes (renamed keys, moved directories, changed defaults), a migration script handles the transition automatically. Migrations run once, in order, during the first `sync` or `update` after upgrading the package.

Example output:

```
◇ Config upgraded 0.5.0 → 0.6.0 (1 migration(s))
```

If no migration script exists for a version (the common case), only the version field is updated — no other changes are made.

### Adding a migration

Migrations live in `src/lib/migrations/index.ts`. Each entry specifies the target version and a function that transforms the config:

```ts
migrations.push({
  version: '0.6.0',
  description: 'rename foo to bar',
  migrate: async (repoRoot, config) => {
    // modify config and/or filesystem
    return { ...config, /* changes */ };
  },
});
```

Migrations only run for configs with a version older than the migration's target. They execute in semver order and the resulting config is saved to disk.
