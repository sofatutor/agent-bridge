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
      - backend
      - shared
```

Behavior is identical: every listed domain, everything inside it. The old top-level form keeps loading as a fallback, so an un-migrated file never breaks.

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

`init` now asks for tools and sources first, fetches the sources, and shows the actual domains in each one as a grouped checklist. The default domain list `backend,frontend,shared` is gone; non-interactive `init` without `--domains` takes every domain it finds.

## Downgrading

A config with a newer `version` than the installed package is left alone. The 0.14 per-source `domains` field is rejected by 0.13 and earlier, so pin the package version across the team.
