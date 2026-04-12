# Configuration

The config lives at `.agent-bridge/config.yml`:

```yaml
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
