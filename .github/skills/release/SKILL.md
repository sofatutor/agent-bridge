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

### 5. Update version (skip for dev releases)

```bash
# Update package.json version
npm version <new-version> --no-git-tag-version

# Stage the changes
git add package.json package-lock.json

# Commit the version bump
git commit -m "chore(release): v<new-version>"
```

### 6. Create and push tag

```bash
# Create annotated tag
git tag -a "v<version>" -m "Release v<version>"

# Push commit and tag
git push && git push origin "v<version>"
```

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

After the release is complete, always show the user the install command:

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
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.4.0",
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.5.0-beta.1",
    "@sofatutor/agent-bridge": "github:sofatutor/agent-bridge#v0.4.0-dev.abc1234"
  }
}
```

## Edge Cases

- **No commits since last tag**: Ask user if they want to re-release the same version or abort.
- **No package.json**: Abort with error — this skill requires a package.
- **gh CLI not installed**: Provide manual instructions for creating the release on GitHub.
- **Tag already exists**: Abort and inform user. They must delete the tag first if re-releasing.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- Clean working directory (no uncommitted changes)
- Push access to the repository
