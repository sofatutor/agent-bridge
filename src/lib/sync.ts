import { readdir, mkdir, rmdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { BridgeConfig } from './config.js';
import {
  dirExists,
  fileExists,
  copyDirContents,
  removeDir,
  removeFile,
  readManifest,
  writeManifest,
  addToManifest,
  removeFromManifest,
  isManifestFolder,
  manifestEntryName,
  MARKER_FILENAME,
} from './fs.js';
import {
  type Feature,
  type RootFile,
  type ToolRootEntry,
  ROOT_FILES,
  featureMatchesTool,
  featureName,
} from './manifest.js';

// ---------------------------------------------------------------------------
// Feature path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the destination path for a feature inside a tool's folder.
 * For folder-based features: returns the folder path.
 * For file-based features: returns the file path.
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
 * Check whether a folder-based feature destination conflicts with existing user content.
 * Returns `true` when the folder exists and is not tracked in the manifest.
 */
export async function checkFolderConflict(featureTypeDir: string, folderName: string): Promise<boolean> {
  const destPath = join(featureTypeDir, folderName);
  if (!(await dirExists(destPath))) return false;
  
  const manifest = await readManifest(featureTypeDir);
  return !manifest.includes(folderName + '/');
}

/**
 * Check whether a file-based feature destination conflicts with existing user content.
 * Returns `true` when the file exists and is not tracked in the manifest.
 */
export async function checkFileConflict(featureTypeDir: string, fileName: string): Promise<boolean> {
  const filePath = join(featureTypeDir, fileName);
  if (!(await fileExists(filePath))) return false;
  
  const manifest = await readManifest(featureTypeDir);
  return !manifest.includes(fileName);
}

/**
 * Check whether a feature destination conflicts with existing user content.
 * Handles both folder-based and file-based features.
 */
export async function checkPathConflict(
  featureTypeDir: string,
  featureName: string,
  isFile: boolean
): Promise<boolean> {
  if (isFile) {
    return checkFileConflict(featureTypeDir, featureName);
  } else {
    return checkFolderConflict(featureTypeDir, featureName);
  }
}

// ---------------------------------------------------------------------------
// Single feature sync
// ---------------------------------------------------------------------------

/**
 * Sync a folder-based feature: clear destination, copy files, add to manifest.
 */
export async function syncFolderFeature(
  sourcePath: string,
  featureTypeDir: string,
  folderName: string
): Promise<'created' | 'updated'> {
  const destPath = join(featureTypeDir, folderName);
  const existed = await dirExists(destPath);

  if (existed) {
    await removeDir(destPath);
  }

  await mkdir(destPath, { recursive: true });
  await copyDirContents(sourcePath, destPath);
  await addToManifest(featureTypeDir, folderName + '/');

  return existed ? 'updated' : 'created';
}

/**
 * Sync a file-based feature: copy file, add to manifest.
 */
export async function syncFileFeature(
  sourcePath: string,
  featureTypeDir: string,
  fileName: string
): Promise<'created' | 'updated'> {
  const destPath = join(featureTypeDir, fileName);
  const existed = await fileExists(destPath);

  await mkdir(featureTypeDir, { recursive: true });
  await copyFile(sourcePath, destPath);
  await addToManifest(featureTypeDir, fileName);

  return existed ? 'updated' : 'created';
}

/**
 * Sync a feature (folder or file based).
 * @deprecated Use syncFolderFeature or syncFileFeature directly
 */
export async function syncFeature(
  sourcePath: string,
  destPath: string
): Promise<'created' | 'updated'> {
  const featureTypeDir = dirname(destPath);
  const folderName = basename(destPath);
  return syncFolderFeature(sourcePath, featureTypeDir, folderName);
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
// Collect all managed entries from manifests
// ---------------------------------------------------------------------------

interface ManagedEntry {
  /** Full path to the file or folder */
  path: string;
  /** Directory containing the manifest (feature-type dir) */
  manifestDir: string;
  /** Entry as it appears in manifest (with trailing / for folders) */
  manifestEntry: string;
  /** True if folder, false if file */
  isFolder: boolean;
}

/**
 * Recursively collect all managed entries (files and folders) from manifests.
 * Scans for .agentbridge files and reads their contents.
 */
async function collectManagedEntries(dir: string): Promise<ManagedEntry[]> {
  if (!(await dirExists(dir))) return [];

  const result: ManagedEntry[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  // Check if this directory has a manifest
  const manifestEntries = await readManifest(dir);
  for (const entry of manifestEntries) {
    const isFolder = isManifestFolder(entry);
    const name = manifestEntryName(entry);
    result.push({
      path: join(dir, name),
      manifestDir: dir,
      manifestEntry: entry,
      isFolder,
    });
  }

  // Recurse into subdirectories (to find manifests in nested feature-type dirs)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === MARKER_FILENAME) continue;
    
    const fullPath = join(dir, entry.name);
    const sub = await collectManagedEntries(fullPath);
    result.push(...sub);
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
  errors: Array<{ path: string; error: string }>;
}

interface ExpectedFeature {
  sourcePath: string;
  featureTypeDir: string;
  name: string;
  manifestEntry: string;
  isFile: boolean;
}

export async function reconcileFeatures(
  repoRoot: string,
  config: BridgeConfig,
  features: Feature[]
): Promise<ReconcileResult> {
  let added = 0;
  let updated = 0;
  let removed = 0;
  const errors: Array<{ path: string; error: string }> = [];

  // Phase 1: Compute all expected features
  // Key = full destination path
  const expectedFeatures = new Map<string, ExpectedFeature>();

  for (const tool of config.tools) {
    for (const feature of features) {
      if (!featureMatchesTool(feature, tool.name)) continue;

      const name = featureName(feature);
      const featureTypeDir = join(repoRoot, tool.folder, feature.displayType);
      const destPath = join(featureTypeDir, name);
      const manifestEntry = feature.isFile ? name : name + '/';

      expectedFeatures.set(destPath, {
        sourcePath: feature.absolutePath,
        featureTypeDir,
        name,
        manifestEntry,
        isFile: feature.isFile,
      });
    }
  }

  // Phase 2: Remove orphaned managed entries (previously synced but no longer expected)
  for (const tool of config.tools) {
    const toolDir = join(repoRoot, tool.folder);
    const managedEntries = await collectManagedEntries(toolDir);

    for (const entry of managedEntries) {
      if (expectedFeatures.has(entry.path)) continue;

      try {
        if (entry.isFolder) {
          await removeDir(entry.path);
        } else {
          await removeFile(entry.path);
        }
        await removeFromManifest(entry.manifestDir, entry.manifestEntry);
        await removeEmptyParents(entry.manifestDir, toolDir);
        removed++;
      } catch (err) {
        errors.push({
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Phase 3: Create / update features (isolate failures so one bad feature
  // doesn't abort the entire sync).
  for (const [destPath, expected] of expectedFeatures) {
    try {
      const result = expected.isFile
        ? await syncFileFeature(
            expected.sourcePath,
            expected.featureTypeDir,
            expected.name
          )
        : await syncFolderFeature(
            expected.sourcePath,
            expected.featureTypeDir,
            expected.name
          );

      if (result === 'created') added++;
      else if (result === 'updated') updated++;
    } catch (err) {
      errors.push({
        path: destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { added, updated, removed, errors };
}

// ---------------------------------------------------------------------------
// Root file sync
// ---------------------------------------------------------------------------

const ROOT_FILE_MARKER = '<!-- Managed by Agent Bridge -->';

/**
 * Check if a root file at `destPath` is managed by Agent Bridge.
 * A file is managed if it starts with the marker comment.
 */
export async function isRootFileManaged(destPath: string): Promise<boolean> {
  if (!(await fileExists(destPath))) return false;
  const content = await readFile(destPath, 'utf-8');
  return content.startsWith(ROOT_FILE_MARKER);
}

export interface RootFileSyncResult {
  synced: string[];
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Sync root files: copy source root files to the workspace root, and clean up
 * managed root files that are no longer provided by any source.
 */
export async function syncRootFiles(
  repoRoot: string,
  rootFiles: RootFile[]
): Promise<RootFileSyncResult> {
  const synced: string[] = [];
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Build map: fileName → rootFile (already deduplicated by caller)
  const expected = new Map<string, RootFile>();
  for (const rf of rootFiles) {
    expected.set(rf.fileName, rf);
  }

  // Sync expected root files
  for (const [fileName, rf] of expected) {
    const destPath = join(repoRoot, fileName);
    try {
      // If file exists and is NOT managed by us, skip (don't overwrite user files)
      if (await fileExists(destPath)) {
        if (!(await isRootFileManaged(destPath))) {
          continue;
        }
      }

      const sourceContent = await readFile(rf.absolutePath, 'utf-8');
      const managedContent = ROOT_FILE_MARKER + '\n' + sourceContent;
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, managedContent, 'utf-8');
      synced.push(fileName);
    } catch (err) {
      errors.push({
        path: destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Remove managed root files no longer provided by any source
  for (const fileName of ROOT_FILES) {
    if (expected.has(fileName)) continue;
    const destPath = join(repoRoot, fileName);
    try {
      if (await isRootFileManaged(destPath)) {
        await removeFile(destPath);
        removed.push(fileName);
      }
    } catch (err) {
      errors.push({
        path: destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { synced, removed, errors };
}

// ---------------------------------------------------------------------------
// Tool root entry sync (_tool convention)
// ---------------------------------------------------------------------------

export interface ToolRootSyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Reconcile tool root entries: sync expected entries and remove orphans.
 * Entries from `_tool` directories are copied directly into the tool's root folder.
 */
export async function reconcileToolRootEntries(
  repoRoot: string,
  config: BridgeConfig,
  entries: ToolRootEntry[]
): Promise<ToolRootSyncResult> {
  let added = 0;
  let updated = 0;
  let removed = 0;
  const errors: Array<{ path: string; error: string }> = [];

  // Build tool name → folder mapping
  const toolFolders = new Map<string, string>();
  for (const tool of config.tools) {
    toolFolders.set(tool.name, tool.folder);
  }

  // Key = destination path, value = entry info
  const expectedEntries = new Map<
    string,
    { sourcePath: string; name: string; isFile: boolean; toolDir: string }
  >();

  for (const entry of entries) {
    const folder = toolFolders.get(entry.toolName);
    if (!folder) continue;

    const toolDir = join(repoRoot, folder);
    const destPath = join(toolDir, entry.name);

    expectedEntries.set(destPath, {
      sourcePath: entry.absolutePath,
      name: entry.name,
      isFile: entry.isFile,
      toolDir,
    });
  }

  // Remove orphaned managed entries from tool root directories
  for (const tool of config.tools) {
    const toolDir = join(repoRoot, tool.folder);
    const manifest = await readManifest(toolDir);

    for (const manifestEntry of manifest) {
      const isFolder = isManifestFolder(manifestEntry);
      const name = manifestEntryName(manifestEntry);
      const destPath = join(toolDir, name);

      if (expectedEntries.has(destPath)) continue;

      try {
        if (isFolder) {
          await removeDir(destPath);
        } else {
          await removeFile(destPath);
        }
        await removeFromManifest(toolDir, manifestEntry);
        removed++;
      } catch (err) {
        errors.push({
          path: destPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Sync expected entries
  for (const [, expected] of expectedEntries) {
    try {
      const result = expected.isFile
        ? await syncFileFeature(
            expected.sourcePath,
            expected.toolDir,
            expected.name
          )
        : await syncFolderFeature(
            expected.sourcePath,
            expected.toolDir,
            expected.name
          );

      if (result === 'created') added++;
      else if (result === 'updated') updated++;
    } catch (err) {
      errors.push({
        path: join(expected.toolDir, expected.name),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { added, updated, removed, errors };
}
