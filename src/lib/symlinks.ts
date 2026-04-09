import { symlink, readlink, unlink, lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import type { BridgeConfig } from './config.js';
import { dirExists, listFilesRecursive } from './fs.js';
import {
  type Feature,
  featureMatchesTool,
  symlinkName,
} from './manifest.js';

export interface SymlinkEntry {
  linkPath: string;
  targetPath: string;
}

export function resolveRelativePath(from: string, to: string): string {
  return relative(dirname(from), to);
}

/**
 * Build a symlink entry for a feature in a tool's folder.
 *
 * @param repoRoot  Host repo root
 * @param toolFolder  Tool folder name (e.g. ".github")
 * @param featureType  Display type (prefix-stripped, e.g. "skills")
 * @param featureName  Display name (prefix-stripped, e.g. "foundation")
 * @param absoluteTargetPath  Absolute path to source feature dir
 */
export function buildSymlinkEntry(
  repoRoot: string,
  toolFolder: string,
  featureType: string,
  featureName: string,
  absoluteTargetPath: string
): SymlinkEntry {
  const linkPath = join(repoRoot, toolFolder, featureType, featureName);
  return { linkPath, targetPath: absoluteTargetPath };
}

/**
 * Build symlink entries for each file inside a feature directory.
 * Instead of one symlink per feature folder, creates one symlink per file.
 */
export async function buildFileSymlinkEntries(
  repoRoot: string,
  toolFolder: string,
  featureType: string,
  featureName: string,
  absoluteFeaturePath: string
): Promise<SymlinkEntry[]> {
  const files = await listFilesRecursive(absoluteFeaturePath);
  return files.map((relFile) => ({
    linkPath: join(repoRoot, toolFolder, featureType, featureName, relFile),
    targetPath: join(absoluteFeaturePath, relFile),
  }));
}

export async function checkPathConflict(linkPath: string): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    return !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function createSymlink(
  entry: SymlinkEntry
): Promise<'created' | 'updated'> {
  const relTarget = resolveRelativePath(entry.linkPath, entry.targetPath);
  await mkdir(dirname(entry.linkPath), { recursive: true });

  try {
    const stats = await lstat(entry.linkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(
        `Path conflict: "${entry.linkPath}" exists as a real file or directory, not a symlink`
      );
    }
    const existing = await readlink(entry.linkPath);
    if (existing === relTarget) return 'updated';
    await unlink(entry.linkPath);
    await symlink(relTarget, entry.linkPath);
    return 'updated';
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path conflict:'))
      throw err;
  }

  await symlink(relTarget, entry.linkPath);
  return 'created';
}

export async function removeSymlink(linkPath: string): Promise<void> {
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      await unlink(linkPath);
    }
  } catch {
    // already gone
  }
}

export async function isSymlinkValid(
  linkPath: string,
  expectedTargetPath: string
): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return false;

    const actual = await readlink(linkPath);
    const expected = resolveRelativePath(linkPath, expectedTargetPath);
    return actual === expected;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Empty directory cleanup
// ---------------------------------------------------------------------------

export async function removeEmptyParents(
  dirPath: string,
  stopAt: string
): Promise<void> {
  let current = dirPath;
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) break;
      await rmdir(current);
      current = dirname(current);
    } catch {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Collect all symlinks recursively under a directory
// ---------------------------------------------------------------------------

async function collectSymlinks(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      result.push(fullPath);
    } else if (entry.isDirectory()) {
      const sub = await collectSymlinks(fullPath);
      result.push(...sub);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reconciliation (high-level)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  added: number;
  updated: number;
  removed: number;
}

export async function reconcileSymlinks(
  repoRoot: string,
  config: BridgeConfig,
  features: Feature[]
): Promise<ReconcileResult> {
  let added = 0;
  let updated = 0;
  let removed = 0;

  // Phase 1: Compute all expected file-level symlink entries
  const expectedEntries = new Map<string, SymlinkEntry>();

  for (const tool of config.tools) {
    for (const feature of features) {
      if (!featureMatchesTool(feature, tool.name)) continue;

      const linkName = symlinkName(feature);
      const entries = await buildFileSymlinkEntries(
        repoRoot,
        tool.folder,
        feature.displayType,
        linkName,
        feature.absolutePath
      );

      for (const entry of entries) {
        expectedEntries.set(entry.linkPath, entry);
      }
    }
  }

  // Phase 2: Remove orphaned symlinks (handles migration from dir-level too)
  for (const tool of config.tools) {
    const toolDir = join(repoRoot, tool.folder);
    if (!(await dirExists(toolDir))) continue;

    const allSymlinks = await collectSymlinks(toolDir);
    for (const link of allSymlinks) {
      if (expectedEntries.has(link)) continue;
      await removeSymlink(link);
      await removeEmptyParents(dirname(link), toolDir);
      removed++;
    }
  }

  // Phase 3: Create / update file-level symlinks
  for (const [, entry] of expectedEntries) {
    const valid = await isSymlinkValid(entry.linkPath, entry.targetPath);
    if (valid) continue;

    const result = await createSymlink(entry);
    if (result === 'created') added++;
    else if (result === 'updated') updated++;
  }

  return { added, updated, removed };
}
