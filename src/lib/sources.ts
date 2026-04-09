import { execSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type SourceConfig,
  type BridgeConfig,
  bridgeDir,
  sourceDir,
  isRemoteSource,
} from './config.js';
import { dirExists } from './fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// ---------------------------------------------------------------------------
// Git operations for a single remote source
// ---------------------------------------------------------------------------

export async function cloneSource(
  repoRoot: string,
  source: SourceConfig
): Promise<void> {
  const dest = sourceDir(repoRoot, source.name);

  await mkdir(bridgeDir(repoRoot), { recursive: true });

  const branchArgs = source.branch
    ? `--single-branch --branch ${source.branch}`
    : '';
  execSync(
    `git clone --depth 1 ${branchArgs} ${source.source} ${dest}`,
    { stdio: 'pipe' }
  );
}

export async function fetchSource(
  repoRoot: string,
  source: SourceConfig
): Promise<void> {
  const dest = sourceDir(repoRoot, source.name);

  exec('git fetch --prune origin', dest);

  if (source.branch) {
    const currentBranch = exec('git rev-parse --abbrev-ref HEAD', dest);
    if (currentBranch !== source.branch) {
      exec(`git checkout ${source.branch}`, dest);
    }
  }

  try {
    exec('git pull --ff-only', dest);
  } catch {
    // pull may fail for tags or detached HEAD — that's okay after fetch
  }
}

// ---------------------------------------------------------------------------
// Local source resolution
// ---------------------------------------------------------------------------

export function resolveLocalSource(
  repoRoot: string,
  source: SourceConfig
): string {
  const raw = source.source;
  if (raw.startsWith('/')) return raw;
  return resolve(repoRoot, raw);
}

// ---------------------------------------------------------------------------
// Resolve the effective filesystem path for a source
// ---------------------------------------------------------------------------

export function resolveSourcePath(
  repoRoot: string,
  source: SourceConfig
): string {
  if (isRemoteSource(source.source)) {
    return sourceDir(repoRoot, source.name);
  }
  return resolveLocalSource(repoRoot, source);
}

// ---------------------------------------------------------------------------
// Sync all sources
// ---------------------------------------------------------------------------

export interface SourceSyncResult {
  name: string;
  action: 'cloned' | 'updated' | 'local';
  error?: string;
}

export async function syncSource(
  repoRoot: string,
  source: SourceConfig
): Promise<SourceSyncResult> {
  if (!isRemoteSource(source.source)) {
    const resolved = resolveLocalSource(repoRoot, source);
    if (!(await dirExists(resolved))) {
      return {
        name: source.name,
        action: 'local',
        error: `Local source path does not exist: ${resolved}\n  Update the path in .agent-bridge/config.yml or run "agent-bridge init" to reconfigure.`,
      };
    }
    return { name: source.name, action: 'local' };
  }

  const dest = sourceDir(repoRoot, source.name);

  if (await dirExists(dest)) {
    try {
      await fetchSource(repoRoot, source);
      return { name: source.name, action: 'updated' };
    } catch (err) {
      return {
        name: source.name,
        action: 'updated',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    await cloneSource(repoRoot, source);
    return { name: source.name, action: 'cloned' };
  } catch (err) {
    return {
      name: source.name,
      action: 'cloned',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncAllSources(
  repoRoot: string,
  config: BridgeConfig
): Promise<SourceSyncResult[]> {
  return Promise.all(config.sources.map((source) => syncSource(repoRoot, source)));
}

// ---------------------------------------------------------------------------
// Remove sources that no longer exist in config
// ---------------------------------------------------------------------------

export async function removeStaleSourceDirs(
  repoRoot: string,
  config: BridgeConfig
): Promise<string[]> {
  const bridge = bridgeDir(repoRoot);
  if (!(await dirExists(bridge))) return [];

  const entries = await readdir(bridge, { withFileTypes: true });

  const configuredNames = new Set(
    config.sources.filter((s) => isRemoteSource(s.source)).map((s) => s.name)
  );

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (configuredNames.has(entry.name)) continue;

    // Check if this looks like a cloned source (has .git)
    const dotGit = join(bridge, entry.name, '.git');
    if (await dirExists(dotGit)) {
      await rm(join(bridge, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }

  return removed;
}


