---
name: commit
description: Create conventional commits with automatic semantic version bumping. Use this skill when the user says "commit", "/commit", "commit changes", "commit and push", or wants to save their work to git. Analyzes staged changes to determine the appropriate commit type and whether to bump major, minor, or patch version.
---

# Commit Skill

Create conventional commits and automatically bump the package version based on the nature of the changes.

## Workflow

1. **Check staged changes** — Run `git diff --cached --stat` to see what's staged. If nothing is staged, run `git status` and ask the user what to stage, or suggest `git add -A`.

2. **Analyze the diff** — Run `git diff --cached` to understand the actual changes. Determine:
   - What type of change is this? (feat, fix, refactor, docs, test, chore, etc.)
   - What scope applies? (e.g., cli, config, sync, git)
   - Is this a breaking change?

3. **Determine version bump** — Based on conventional commits and semver:
   - **MAJOR** (x.0.0): Breaking changes (indicated by `!` or `BREAKING CHANGE` in body)
   - **MINOR** (0.x.0): New features (`feat:`)
   - **PATCH** (0.0.x): Bug fixes (`fix:`), performance improvements (`perf:`)
   - **No bump**: Everything else — `docs`, `refactor`, `test`, `chore`, `style`, `ci`
   
   Only user-facing changes bump the version. Internal changes (refactors, tests, docs) don't.

4. **Bump the version (if needed)** — Only for `feat`, `fix`, `perf`, or breaking changes:
   ```bash
   npm version <major|minor|patch> --no-git-tag-version
   ```
   Then stage the updated files:
   ```bash
   git add package.json package-lock.json
   ```
   
   Skip this step entirely for `docs`, `refactor`, `test`, `chore`, `style`, `ci`.

5. **Create the commit** — Use the conventional commit format:
   ```bash
   git commit -m "<type>(<scope>): <description>"
   ```

6. **Offer to push** — Ask if the user wants to push, then run `git push` if confirmed.

## Conventional Commit Types

| Type       | Description                                    | Version Bump |
|------------|------------------------------------------------|--------------|
| `feat`     | New feature for users                          | MINOR        |
| `fix`      | Bug fix for users                              | PATCH        |
| `docs`     | Documentation only                             | none         |
| `style`    | Formatting, no code change                     | none         |
| `refactor` | Code restructure, no behavior change           | none         |
| `test`     | Adding or fixing tests                         | none         |
| `chore`    | Build, tooling, dependencies                   | none         |
| `perf`     | Performance improvement                        | PATCH        |
| `ci`       | CI/CD changes                                  | none         |

## Breaking Changes

If changes are breaking (API changes, removed features, changed behavior), append `!` after the type:
```
feat(api)!: remove deprecated endpoints
```
This triggers a MAJOR version bump.

## Examples

**Example 1: New feature**
```
Staged: src/commands/export.ts (new file)
Commit: feat(cli): add export command
Version: 0.3.0 → 0.4.0 (minor bump)
```

**Example 2: Bug fix**
```
Staged: src/lib/sync.ts (modified)
Commit: fix(sync): handle empty directories correctly
Version: 0.4.0 → 0.4.1 (patch bump)
```

**Example 3: Refactoring (no bump)**
```
Staged: src/lib/config.ts, src/lib/manifest.ts (modified)
Commit: refactor(config): extract validation into separate module
Version: 0.4.1 (unchanged)
```

**Example 4: Multiple changes**
If the staged changes span multiple types, use the highest-impact type for the commit message and mention others in the body if needed. The version bump follows the highest-impact change.

## Edge Cases

- **Pre-1.0 versions**: For 0.x.y versions, breaking changes bump MINOR instead of MAJOR (common convention).
- **No package.json**: Skip version bumping, just do the conventional commit.
- **Already bumped**: If version was manually bumped in the staged changes, don't bump again.
- **Monorepo**: Look for the nearest package.json to the changed files.

## Don't Forget

- Always stage `package-lock.json` alongside `package.json` after version bump
- Keep commit messages concise (50 chars for subject line ideal, 72 max)
- Use imperative mood: "add feature" not "added feature"
