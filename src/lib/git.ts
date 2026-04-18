import { execSync } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export function findRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Check if a directory is inside a Git repository.
 */
export function isInGitRepo(cwd?: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to the .git/hooks directory.
 */
export function getGitHooksDir(repoRoot: string): string {
  return join(repoRoot, '.git', 'hooks');
}

/**
 * The hook names that Agent Bridge will install.
 */
export const AGENT_BRIDGE_HOOKS = ['post-checkout', 'post-merge'] as const;
export type AgentBridgeHook = (typeof AGENT_BRIDGE_HOOKS)[number];

/**
 * Marker comment to identify Agent Bridge hooks.
 */
const HOOK_MARKER = '# agent-bridge-hook';

/**
 * Generate the hook script content.
 * Runs update and sync in the background, logging to `.agent-bridge/hook.log`
 * (trimmed to the last ~200 lines) so failures are diagnosable.
 */
export function generateHookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# This hook was installed by Agent Bridge.
# It runs 'agent-bridge update && agent-bridge sync' in the background
# to keep your AI agent configurations up to date.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
LOG_DIR="\${REPO_ROOT:-.}/.agent-bridge"
LOG_FILE="\${LOG_DIR}/hook.log"

mkdir -p "\$LOG_DIR" 2>/dev/null

(
  # Wait a moment for git to finish
  sleep 1

  {
    echo "--- $(date '+%Y-%m-%dT%H:%M:%S%z') agent-bridge hook ---"
    if command -v agent-bridge >/dev/null 2>&1; then
      agent-bridge update && agent-bridge sync
    elif command -v npx >/dev/null 2>&1; then
      npx @sofatutor/agent-bridge update && npx @sofatutor/agent-bridge sync
    else
      echo "agent-bridge not found (install globally or ensure npx is available)"
    fi
  } >>"\$LOG_FILE" 2>&1

  # Keep the log from growing without bound.
  if [ -f "\$LOG_FILE" ]; then
    tail -n 200 "\$LOG_FILE" >"\$LOG_FILE.tmp" && mv "\$LOG_FILE.tmp" "\$LOG_FILE"
  fi
) </dev/null >/dev/null 2>&1 &
`;
}

/**
 * Check if a hook file contains the Agent Bridge marker.
 */
export async function hasAgentBridgeHook(hookPath: string): Promise<boolean> {
  try {
    const content = await readFile(hookPath, 'utf-8');
    return content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Check if a hook file exists.
 */
async function hookExists(hookPath: string): Promise<boolean> {
  try {
    await access(hookPath);
    return true;
  } catch {
    return false;
  }
}

export interface InstallHooksResult {
  installed: AgentBridgeHook[];
  skipped: AgentBridgeHook[];
  errors: Array<{ hook: AgentBridgeHook; error: string }>;
}

/**
 * Install Agent Bridge git hooks in the repository.
 * 
 * @param repoRoot - The root of the git repository
 * @param force - If true, overwrite existing hooks that don't have the marker
 * @returns Result with installed, skipped, and errored hooks
 */
export async function installGitHooks(
  repoRoot: string,
  force = false
): Promise<InstallHooksResult> {
  const result: InstallHooksResult = {
    installed: [],
    skipped: [],
    errors: [],
  };

  if (!isInGitRepo(repoRoot)) {
    for (const hook of AGENT_BRIDGE_HOOKS) {
      result.errors.push({ hook, error: 'Not a git repository' });
    }
    return result;
  }

  const hooksDir = getGitHooksDir(repoRoot);

  // Ensure hooks directory exists
  try {
    await mkdir(hooksDir, { recursive: true });
  } catch (err) {
    for (const hook of AGENT_BRIDGE_HOOKS) {
      result.errors.push({ hook, error: `Failed to create hooks directory: ${err}` });
    }
    return result;
  }

  const hookContent = generateHookScript();

  for (const hookName of AGENT_BRIDGE_HOOKS) {
    const hookPath = join(hooksDir, hookName);

    try {
      const exists = await hookExists(hookPath);
      
      if (exists) {
        const hasMarker = await hasAgentBridgeHook(hookPath);
        
        if (hasMarker) {
          // Already installed, update it
          await writeFile(hookPath, hookContent, 'utf-8');
          await chmod(hookPath, 0o755);
          result.installed.push(hookName);
        } else if (force) {
          // Force overwrite
          await writeFile(hookPath, hookContent, 'utf-8');
          await chmod(hookPath, 0o755);
          result.installed.push(hookName);
        } else {
          // Skip - existing hook without marker
          result.skipped.push(hookName);
        }
      } else {
        // Create new hook
        await writeFile(hookPath, hookContent, 'utf-8');
        await chmod(hookPath, 0o755);
        result.installed.push(hookName);
      }
    } catch (err) {
      result.errors.push({ hook: hookName, error: String(err) });
    }
  }

  return result;
}

/**
 * Remove Agent Bridge git hooks from the repository.
 * Only removes hooks that have the Agent Bridge marker.
 */
export async function removeGitHooks(repoRoot: string): Promise<AgentBridgeHook[]> {
  const removed: AgentBridgeHook[] = [];

  if (!isInGitRepo(repoRoot)) {
    return removed;
  }

  const hooksDir = getGitHooksDir(repoRoot);

  for (const hookName of AGENT_BRIDGE_HOOKS) {
    const hookPath = join(hooksDir, hookName);
    
    try {
      if (await hasAgentBridgeHook(hookPath)) {
        const { unlink } = await import('node:fs/promises');
        await unlink(hookPath);
        removed.push(hookName);
      }
    } catch {
      // Ignore errors
    }
  }

  return removed;
}
