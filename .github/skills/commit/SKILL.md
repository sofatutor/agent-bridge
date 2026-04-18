---
name: commit
description: Create conventional commits. Use this skill when the user says "commit", "/commit", "commit changes", "commit and push", or wants to save their work to git. Analyzes staged changes to determine the appropriate commit type and scope.
---

# Commit Skill

Create conventional commits following the conventional commits specification.

> **Note:** This skill does NOT bump versions. Use the `release` skill for versioning and tagging.

## Workflow

1. **Check available changes** — Run `git status` to see all uncommitted changes (staged and unstaged).

2. **Analyze and group changes** — Run `git diff` (unstaged) and `git diff --cached` (staged) to understand the changes. Group them into logical commits based on:
   - **Purpose**: Each commit should do ONE thing (a feature, a fix, a refactor, etc.)
   - **Scope**: Changes to the same module/area often belong together
   - **Independence**: Could this change be reverted independently?

3. **Create commits one at a time** — For each logical group:

   ```bash
   # Stage only the files for this commit
   git add <specific-files>

   # Create the commit
   git commit -m "<type>(<scope>): <description>"
   ```

   Repeat until all changes are committed.

4. **Offer to push** — After all commits, ask if the user wants to push, then run `git push` if confirmed.

## When to Split Commits

**Split into separate commits:**

- A new feature AND a bug fix → 2 commits
- Code changes AND documentation → 2 commits
- A refactor AND a new feature that uses it → 2 commits
- Changes to unrelated modules → separate commits per module
- Test file additions AND the code they test → can be 1 commit (related)

**Keep as one commit:**

- A feature and its tests (same logical unit)
- A fix and the test that covers it
- Related changes to multiple files in the same module
- Small, focused changes even if they touch multiple files

## Example: Multiple Commits

```
Changes detected:
  M src/lib/config.ts      (refactored validation)
  M src/lib/sync.ts        (fixed empty dir bug)
  A src/commands/export.ts (new feature)
  M docs/configuration.md  (updated docs)

→ Commit 1: refactor(config): extract validation logic
→ Commit 2: fix(sync): handle empty directories
→ Commit 3: feat(cli): add export command
→ Commit 4: docs(config): update configuration guide
```

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

## Guidelines

- Keep commit messages concise (50 chars for subject line ideal, 72 max)
- Use imperative mood: "add feature" not "added feature"
- Scope is optional but recommended for clarity
- One logical change per commit — easier to review, revert, and bisect
