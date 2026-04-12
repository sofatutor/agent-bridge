import { readdir, mkdir, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { BridgeConfig } from './config.js';
import { dirExists, copyDirContents, writeMarker, hasMarker, removeDir, MARKER_FILENAME } from './fs.js';
import {
  type Feature,
  featureMatchesTool,
  featureName,
} from './manifest.js';

// ---------------------------------------------------------------------------
// Feature folder path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the destination path for a feature inside a tool's folder.
 */
export function featureDestPath(
  repoRoot: string,
  toolFolder: string,
  featureType: string,
  featureName: string
): string {
  return join(repoRoot, toolFolder, featureType, featureName);
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Check whether a feature destination conflicts with existing user content.
 *
 * Returns `true` (conflict) when the path exists as a directory that does NOT
 * contain the `.agentbridge` marker — meaning it was not created by us.
 * A non-existent path or a previously-synced folder (has marker) is safe.
 */
export async function checkPathConflict(destPath: string): Promise<boolean> {
  if (!(await dirExists(destPath))) return false;
  return !(await hasMarker(destPath));
}

// ---------------------------------------------------------------------------
// Single feature sync
// ---------------------------------------------------------------------------

/**
 * Sync a single feature: clear destination, copy files, write marker.
 * Returns whether the feature was freshly added or updated.
 */
export async function syncFeature(
  sourcePath: string,
  destPath: string
): Promise<'created' | 'updated'> {
  const existed = await dirExists(destPath);

  // If the folder already exists (from a previous sync), remove its contents.
  if (existed) {
    await removeDir(destPath);
  }

  await mkdir(destPath, { recursive: true });
  await copyDirContents(sourcePath, destPath);
  await writeMarker(destPath);

  return existed ? 'updated' : 'created';
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
// Collect all managed feature folders (those with .agentbridge marker)
// ---------------------------------------------------------------------------

async function collectManagedFeatureDirs(dir: string): Promise<string[]> {
  if (!(await dirExists(dir))) return [];

  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(dir, entry.name);
    // Check if this directory itself is a managed feature folder
    if (await hasMarker(fullPath)) {
      result.push(fullPath);
    } else {
      // Recurse deeper (e.g. .github/skills/ → check children)
      const sub = await collectManagedFeatureDirs(fullPath);
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

export async function reconcileFeatures(
  repoRoot: string,
  config: BridgeConfig,
  features: Feature[]
): Promise<ReconcileResult> {
  let added = 0;
  let updated = 0;
  let removed = 0;

  // Phase 1: Compute all expected feature destinations
  const expectedDests = new Map<string, { sourcePath: string }>();

  for (const tool of config.tools) {
    for (const feature of features) {
      if (!featureMatchesTool(feature, tool.name)) continue;

      const linkName = featureName(feature);
      const dest = featureDestPath(
        repoRoot,
        tool.folder,
        feature.displayType,
        linkName
      );
      expectedDests.set(dest, { sourcePath: feature.absolutePath });
    }
  }

  // Phase 2: Remove orphaned managed folders (previously synced but no longer expected)
  for (const tool of config.tools) {
    const toolDir = join(repoRoot, tool.folder);
    const managedDirs = await collectManagedFeatureDirs(toolDir);
    for (const dir of managedDirs) {
      if (expectedDests.has(dir)) continue;
      await removeDir(dir);
      await removeEmptyParents(dirname(dir), toolDir);
      removed++;
    }
  }

  // Phase 3: Create / update feature folders
  for (const [dest, { sourcePath }] of expectedDests) {
    const result = await syncFeature(sourcePath, dest);
    if (result === 'created') added++;
    else if (result === 'updated') updated++;
  }

  return { added, updated, removed };
}
