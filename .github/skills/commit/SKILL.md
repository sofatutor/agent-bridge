---
name: commit
description: Create conventional commits. Use this skill when the user says "commit", "/commit", "commit changes", "commit and push", or wants to save their work to git. Analyzes staged changes to determine the appropriate commit type and scope.
---

# Commit Skill

Create conventional commits following the conventional commits specification.

> **Note:** This skill does NOT bump versions. Use the `release` skill for versioning and tagging.

## Workflow

1. **Check staged changes** — Run `git diff --cached --stat` to see what's staged. If nothing is staged, run `git status` and ask the user what to stage, or suggest `git add -A`.

2. **Analyze the diff** — Run `git diff --cached` to understand the actual changes. Determine:
   - What type of change is this? (feat, fix, refactor, docs, test, chore, etc.)
   - What scope applies? (e.g., cli, config, sync, git)
   - Is this a breaking change?

3. **Create the commit** — Use the conventional commit format:

   ```bash
   git commit -m "<type>(<scope>): <description>"
   ```

4. **Offer to push** — Ask if the user wants to push, then run `git push` if confirmed.

## Conventional Commit Types

| Type       | Description                          |
| ---------- | ------------------------------------ |
| `feat`     | New feature for users                |
| `fix`      | Bug fix for users                    |
| `docs`     | Documentation only                   |
| `style`    | Formatting, no code change           |
| `refactor` | Code restructure, no behavior change |
| `test`     | Adding or fixing tests               |
| `chore`    | Build, tooling, dependencies         |
| `perf`     | Performance improvement              |
| `ci`       | CI/CD changes                        |

## Breaking Changes

If changes are breaking (API changes, removed features, changed behavior), append `!` after the type:

```
feat(api)!: remove deprecated endpoints
```

## Examples

```
feat(cli): add export command
fix(sync): handle empty directories correctly
refactor(config): extract validation into separate module
docs(readme): add installation instructions
chore(deps): update vitest to v2.0
```

## Multiple Changes

If the staged changes span multiple types, use the highest-impact type for the commit message. Priority order: breaking > feat > fix > perf > refactor > others.

## Guidelines

- Keep commit messages concise (50 chars for subject line ideal, 72 max)
- Use imperative mood: "add feature" not "added feature"
- Scope is optional but recommended for clarity
