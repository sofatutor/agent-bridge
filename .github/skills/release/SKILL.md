---
name: release
description: Create GitHub releases with semantic versioning. Use this skill when the user says "release", "/release", "create release", "release beta", "release dev", or wants to tag and publish a version to GitHub. This creates git tags and GitHub releases for installing via github:user/repo#tag.
---

# Release Skill

Create GitHub releases with git tags for version-specific installation via:

```
"@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v1.0.0"
```

> **Note:** This skill is for GitHub releases (tags). For npm publishing, use the `publish` skill.

## Release Types

| Command        | Example Output     | Description               |
| -------------- | ------------------ | ------------------------- |
| `release`      | v0.4.0             | Stable release            |
| `release beta` | v0.4.0-beta.1      | Beta prerelease           |
| `release dev`  | v0.4.0-dev.abc1234 | Dev snapshot (commit SHA) |

## Workflow

### 1. Pre-flight checks

```bash
# Ensure working directory is clean
git status --porcelain
```

If there are uncommitted changes, abort and ask user to commit first.

```bash
# Get current version from package.json
node -p "require('./package.json').version"

# Get latest tag
git describe --tags --abbrev=0 2>/dev/null || echo "none"
```

### 2. Confirm release type

If the user did not specify a release type, ask them:

> What type of release?
>
> - **stable** — Production release (v0.4.0)
> - **beta** — Beta prerelease (v0.4.0-beta.1)
> - **dev** — Development snapshot (v0.4.0-dev.abc1234)

Do NOT proceed until the user confirms the release type.

### 3. Analyze commits for version bump

Only for stable and beta releases. Skip for dev releases.

```bash
# Get commits since last tag (or all commits if no tags)
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --pretty=format:"%s"
```

Determine bump type from commit messages:

- **MAJOR**: Any commit with `!` after type (e.g., `feat!:`, `fix(api)!:`) or contains `BREAKING CHANGE`
- **MINOR**: Any `feat:` commit
- **PATCH**: Any `fix:` or `perf:` commit
- **No bump needed**: Only `docs`, `refactor`, `test`, `chore`, `style`, `ci` commits

Use the highest-impact change. For pre-1.0 versions, breaking changes bump MINOR instead of MAJOR.

### 4. Calculate new version

**For `release` (stable):**

- If current version has prerelease suffix (e.g., `0.4.0-beta.2`), strip it → `0.4.0`
- Otherwise, bump based on commits → `0.4.0` → `0.5.0` (if feat) or `0.4.1` (if fix)

**For `release beta`:**

- If current is already beta, increment beta number → `0.4.0-beta.1` → `0.4.0-beta.2`
- Otherwise, bump version and add beta.1 → `0.4.0` → `0.5.0-beta.1` (based on commits)

**For `release dev`:**

- Use current version + `-dev.{short SHA}` → `0.4.0-dev.abc1234`
- Does NOT modify package.json

### 5. Update version via a PR (skip for dev releases)

> **`main` is protected — no direct pushes.** The version-bump commit must land through a
> pull request. Do NOT run `git push` against `main`.

First decide where the bump commit goes:

```bash
git rev-parse --abbrev-ref HEAD   # current branch
gh pr status                      # is there already a PR for it?
```

- **Already on a feature branch with an open PR** → add the bump commit to that branch and merge
  the existing PR. Skip the `checkout main`/`checkout -b` lines below; run `npm version …` onward
  on the current branch, then `git push` (no `-u`) and `gh pr merge --merge --delete-branch`.
- **On `main` (or a branch with no PR)** → branch off `main` for a dedicated release PR:

```bash
# Branch off main for the release
git checkout main && git pull --ff-only
git checkout -b "chore/release-v<new-version>"

# Update package.json version (this may trigger lifecycle scripts like "version")
npm version <new-version> --no-git-tag-version

# Stage ALL files modified by npm version (includes package.json, package-lock.json,
# and any files produced by lifecycle scripts like the "version" script)
git add -A

# Commit the version bump and push the branch
git commit -m "chore(release): v<new-version>"
git push -u origin "chore/release-v<new-version>"

# Open and merge the release PR (self-merge is allowed, no approval required)
gh pr create --base main --title "chore(release): v<new-version>" --fill
gh pr merge --merge --delete-branch
```

> **Note:** The `npm version` command triggers the `version` lifecycle script if defined in package.json.
> This project's `version` script rebuilds `dist/` and stages it. Always use `git add -A` to capture
> all side effects (lockfile updates, rebuilt artifacts, etc.).
>
> If the release changes are small and already under review, you may instead fold the version-bump
> commit into that existing PR rather than opening a separate one.

### 6. Create and push tag

The tag must point at the **merged commit on `main`**, so tag only after the PR merges.

```bash
# Sync main to the merged release commit
git checkout main && git pull --ff-only

# Create annotated tag on main
git tag -a "v<version>" -m "Release v<version>"

# Push the tag (branch protection blocks branch pushes, not tags —
# unless a tag ruleset also covers v* tags, in which case create the tag another way)
git push origin "v<version>"
```

> **Dev releases** skip the PR entirely: they don't modify `package.json`, so just tag the current
> commit and push the tag (steps 6–7).

### 7. Create GitHub release

```bash
# For stable releases
gh release create "v<version>" --title "v<version>" --generate-notes

# For beta releases (marked as prerelease)
gh release create "v<version>" --title "v<version>" --generate-notes --prerelease

# For dev releases (marked as prerelease, no notes)
gh release create "v<version>" --title "v<version>" --prerelease --notes "Development snapshot from commit $(git rev-parse --short HEAD)"
```

### 8. Show install command

After the release is complete, always show the user the install commands.

**For stable releases**, recommend the semver syntax (auto-updates within range, avoids npm caching issues with pinned git tags):

```
✓ Released v<version>

Install via (recommended — auto-updates on npm install):
"@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#semver:^<version>"

Or pin to this exact version:
"@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v<version>"
```

**For beta/dev releases**, always pin to the exact tag (semver ranges won't match prereleases):

```
✓ Released v<version>

Install via:
"@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v<version>"
```

## Examples

**Example 1: First stable release**

```
Current version: 0.3.0 (no tags exist)
Commits: feat(cli): add sync command, fix(config): validate paths
Command: release
→ Bumps to 0.4.0 (feat = minor bump)
→ Creates tag v0.4.0
→ Creates GitHub release v0.4.0
```

**Example 2: Beta release**

```
Current version: 0.4.0
Commits: feat(sync): add dry-run mode
Command: release beta
→ Bumps to 0.5.0-beta.1
→ Creates tag v0.5.0-beta.1
→ Creates GitHub prerelease v0.5.0-beta.1
```

**Example 3: Promote beta to stable**

```
Current version: 0.5.0-beta.3
Command: release
→ Strips suffix → 0.5.0
→ Creates tag v0.5.0
→ Creates GitHub release v0.5.0
```

**Example 4: Dev snapshot**

```
Current version: 0.4.0
Current commit: abc1234
Command: release dev
→ Creates tag v0.4.0-dev.abc1234 (no package.json change)
→ Creates GitHub prerelease v0.4.0-dev.abc1234
```

## Installation After Release

```json
{
  "dependencies": {
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#semver:^0.4.0",
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.4.0",
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.5.0-beta.1",
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.4.0-dev.abc1234"
  }
}
```

**Note on npm caching:** When using a pinned tag (`#v0.4.0`), npm caches the resolved commit SHA in `package-lock.json` and won't pick up new releases on `npm install`. Use the `#semver:^x.y.z` syntax instead so npm resolves tags as semver and updates within the range. To force an update from a pinned tag, run `npm uninstall @sofatutor/agent-bridge && npm install github:sofatutor/agent-bridge#v<new-version>`.

## Edge Cases

- **No commits since last tag**: Ask user if they want to re-release the same version or abort.
- **No package.json**: Abort with error — this skill requires a package.
- **gh CLI not installed**: Provide manual instructions for creating the release on GitHub.
- **Tag already exists**: Abort and inform user. They must delete the tag first if re-releasing.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- Clean working directory (no uncommitted changes)
- Permission to open and merge PRs (`main` is protected; version bumps land via PR, self-merge allowed)
- Push access for tags (verify no `v*` tag ruleset blocks tag pushes)
