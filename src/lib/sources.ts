import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile, access } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
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

/**
 * Marker file written inside every directory Agent Bridge manages under
 * `.agent-bridge/`. Used to gate destructive cleanup so we never delete
 * user-placed content.
 */
const SOURCE_MARKER = '.agent-bridge-managed';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

/**
 * Branch names must not contain shell metacharacters or leading dashes
 * (which could be mistaken for git flags). Conservative but safe.
 */
function assertSafeBranch(branch: string, sourceName: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error(
      `Source '${sourceName}': invalid branch name '${branch}'. ` +
        `Branch must match [A-Za-z0-9._/-]+ and not start with '-'.`
    );
  }
}

/**
 * Reject source URLs that begin with '-' to prevent them being interpreted
 * as CLI flags by git.
 */
function assertSafeSourceUrl(source: string, sourceName: string): void {
  if (source.startsWith('-')) {
    throw new Error(
      `Source '${sourceName}': URL must not start with '-' (got '${source}').`
    );
  }
}

async function writeSourceMarker(dest: string): Promise<void> {
  await writeFile(
    join(dest, SOURCE_MARKER),
    'This directory is managed by agent-bridge. Do not edit manually.\n',
    'utf-8'
  );
}

async function hasSourceMarker(dir: string): Promise<boolean> {
  try {
    await access(join(dir, SOURCE_MARKER));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git operations for a single remote source
// ---------------------------------------------------------------------------

export async function cloneSource(
  repoRoot: string,
  source: SourceConfig
): Promise<void> {
  assertSafeSourceUrl(source.source, source.name);
  if (source.branch) assertSafeBranch(source.branch, source.name);

  const dest = sourceDir(repoRoot, source.name);

  await mkdir(bridgeDir(repoRoot), { recursive: true });

  const args = ['clone', '--depth', '1'];
  if (source.branch) {
    args.push('--single-branch', '--branch', source.branch);
  }
  // '--' terminates option parsing so the URL / dest can never be read as flags.
  args.push('--', source.source, dest);

  execFileSync('git', args, { stdio: 'pipe' });

  await writeSourceMarker(dest);
}

export async function fetchSource(
  repoRoot: string,
  source: SourceConfig
): Promise<void> {
  assertSafeSourceUrl(source.source, source.name);
  if (source.branch) assertSafeBranch(source.branch, source.name);

  const dest = sourceDir(repoRoot, source.name);

  git(['fetch', '--prune', 'origin'], dest);

  if (source.branch) {
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dest);
    if (currentBranch !== source.branch) {
      // Branch changed in config — ensure we have the ref then check it out.
      // A shallow --single-branch clone only has one branch, so fetch the
      // new branch explicitly before checkout.
      try {
        git(['fetch', '--depth', '1', 'origin', source.branch], dest);
      } catch {
        // If fetch fails, let checkout surface the real error.
      }
      git(['checkout', source.branch], dest);
    }
  }

  try {
    git(['pull', '--ff-only'], dest);
  } catch {
    // pull may fail for tags or detached HEAD — that's okay after fetch
  }

  // Refresh marker (in case the directory was restored from backup without it).
  await writeSourceMarker(dest);
}

// ---------------------------------------------------------------------------
// Local source resolution
// ---------------------------------------------------------------------------

export function resolveLocalSource(
  repoRoot: string,
  source: SourceConfig
): string {
  const raw = source.source;
  if (isAbsolute(raw)) return raw;
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

/**
 * Remove cloned source directories under `.agent-bridge/` that are no longer
 * referenced in config. Only directories carrying the Agent Bridge marker
 * file are eligible for deletion — user-placed content is always preserved.
 *
 * For backwards compatibility with clones created before the marker existed,
 * directories containing a `.git` folder are also treated as stale.
 */
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

    const candidate = join(bridge, entry.name);

    if (
      (await hasSourceMarker(candidate)) ||
      (await dirExists(join(candidate, '.git')))
    ) {
      await rm(candidate, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }

  return removed;
}
