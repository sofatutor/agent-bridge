import { symlink, readlink, unlink, lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import type { BridgeConfig } from './config.js';
import { dirExists } from './fs.js';
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

  const expectedLinks = new Set<string>();

  for (const tool of config.tools) {
    for (const feature of features) {
      if (!featureMatchesTool(feature, tool.name)) continue;

      const linkName = symlinkName(feature);
      const entry = buildSymlinkEntry(
        repoRoot,
        tool.folder,
        feature.displayType,
        linkName,
        feature.absolutePath
      );
      expectedLinks.add(entry.linkPath);

      const valid = await isSymlinkValid(entry.linkPath, entry.targetPath);
      if (valid) continue;

      const result = await createSymlink(entry);
      if (result === 'created') added++;
      else if (result === 'updated') updated++;
    }

    // Remove orphaned symlinks — scan all subdirs of the tool folder
    const toolDir = join(repoRoot, tool.folder);
    if (!(await dirExists(toolDir))) continue;

    const typeDirs = await readdir(toolDir, { withFileTypes: true });
    for (const typeDir of typeDirs) {
      if (!typeDir.isDirectory()) continue;
      const typePath = join(toolDir, typeDir.name);
      const entries = await readdir(typePath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(typePath, entry.name);
        if (!entry.isSymbolicLink()) continue;
        if (expectedLinks.has(fullPath)) continue;

        await removeSymlink(fullPath);
        await removeEmptyParents(typePath, toolDir);
        removed++;
      }
    }
  }

  return { added, updated, removed };
}
