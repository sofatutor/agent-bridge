# Upgrading

`sync` migrates your config automatically. This page tells you what changed so nothing surprises you.

## 0.13 → 0.14

### `update` merged into `sync`

`agent-bridge sync` always fetched sources first, so `update` was redundant. It is now a hidden alias that runs `sync`.

- Git hooks installed by older versions ran `agent-bridge update && agent-bridge sync`. They still work. The first `sync` rewrites hooks carrying the Agent Bridge marker to run `sync` only.
- Update any scripts or `postinstall` lines to call `sync` alone.

### Domains moved into each source

Before:

```yaml
domains: [backend, shared]
sources:
  - name: hub
    source: https://github.com/org/hub.git
```

After (written for you on the first `sync`):

```yaml
sources:
  - name: hub
    source: https://github.com/org/hub.git
    domains:
      - name: backend
      - name: shared
```

Behavior is identical: every listed domain, everything inside it. The top-level list is kept (and regenerated as the union of all sources' domains) so a teammate still on 0.13 can load the migrated file. They sync those whole domains and ignore `include`; once they upgrade, the per-source lists apply.

### New: pick individual items with `include`

```yaml
    domains:
      - name: shared
        include:
          - skills/code-review
          - AGENTS.md
```

See [Configuration](Configuration.md). Manifests and sync behavior are unchanged: anything you deselect is removed on the next `sync`, like a feature deleted upstream.

### `init` flow

`init` now asks for tools and sources first, fetches the sources, and shows their actual contents as one checkbox tree (domain → feature type → feature). The default domain list `backend,frontend,shared` is gone; non-interactive `init` without `--domains` takes every domain it finds.

## Rolling out across a team

1. Bump `@sofatutor/agent-bridge` in `package.json` (e.g. `^0.15.1`) and merge. Everyone gets the new version on their next `npm install`; the `postinstall` guard (`test -d .agent-bridge || …`) does not need to run again.
2. The first `sync` on a machine (manual, or via the existing git hooks, which still call `update && sync`) migrates `config.yml`: per-source `domains` are added, the version is bumped, and Agent Bridge's own hooks are rewritten to call `sync` only.
3. Commit the migrated `config.yml`. Teammates on the old version can still read it thanks to the top-level `domains` list; teammates on the new version get identical results.

Nothing else changes for existing projects: tool folders, manifests and the `.agent-bridge/` clone layout are the same.

## Downgrading

A config with a newer `version` than the installed package is left alone (no migration runs backwards). Because the top-level `domains` list is always present, 0.13 can still read files written by 0.14+.
