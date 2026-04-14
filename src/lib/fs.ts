import { stat, readdir, copyFile, mkdir, rm, writeFile, readFile, access, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** Name of the marker file placed inside every synced feature folder. */
export const MARKER_FILENAME = '.agentbridge';

export async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursive(join(dir, entry.name));
      files.push(...subFiles.map((f) => join(entry.name, f)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * Copy all files from `srcDir` into `destDir`, preserving nested structure.
 * Overwrites existing files. Creates directories as needed.
 */
export async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  const files = await listFilesRecursive(srcDir);
  for (const relFile of files) {
    const srcFile = join(srcDir, relFile);
    const destFile = join(destDir, relFile);
    await mkdir(dirname(destFile), { recursive: true });
    await copyFile(srcFile, destFile);
  }
}

/**
 * Write the `.agentbridge` marker file into a feature folder.
 */
export async function writeMarker(featureDir: string): Promise<void> {
  await writeFile(join(featureDir, MARKER_FILENAME), '', 'utf-8');
}

/**
 * Check whether a directory contains the `.agentbridge` marker.
 */
export async function hasMarker(featureDir: string): Promise<boolean> {
  return fileExists(join(featureDir, MARKER_FILENAME));
}

/**
 * Remove a directory and all its contents.
 */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Remove a single file.
 */
export async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // File may not exist, ignore
  }
}

// ---------------------------------------------------------------------------
// Manifest helpers (single .agentbridge per feature-type directory)
// ---------------------------------------------------------------------------

/**
 * Read the manifest file in a directory. Returns list of managed entries.
 * Entries ending with '/' are folders, others are files.
 */
export async function readManifest(dir: string): Promise<string[]> {
  const manifestPath = join(dir, MARKER_FILENAME);
  try {
    const content = await readFile(manifestPath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Check if an entry in the manifest is a folder (ends with /).
 */
export function isManifestFolder(entry: string): boolean {
  return entry.endsWith('/');
}

/**
 * Get the base name from a manifest entry (strips trailing / for folders).
 */
export function manifestEntryName(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry;
}

/**
 * Write a manifest file listing managed entries.
 */
export async function writeManifest(dir: string, entries: string[]): Promise<void> {
  const manifestPath = join(dir, MARKER_FILENAME);
  await mkdir(dirname(manifestPath), { recursive: true });
  const content = entries.length > 0 ? entries.join('\n') + '\n' : '';
  await writeFile(manifestPath, content, 'utf-8');
}

/**
 * Add an entry to the manifest. Creates manifest if it doesn't exist.
 * Use trailing '/' for folders.
 */
export async function addToManifest(dir: string, entry: string): Promise<void> {
  const existing = await readManifest(dir);
  if (!existing.includes(entry)) {
    existing.push(entry);
    await writeManifest(dir, existing);
  }
}

/**
 * Remove an entry from the manifest.
 * Deletes the manifest file entirely if it becomes empty.
 */
export async function removeFromManifest(dir: string, entry: string): Promise<void> {
  const existing = await readManifest(dir);
  const updated = existing.filter((e) => e !== entry);
  if (updated.length !== existing.length) {
    if (updated.length === 0) {
      // Remove manifest file when empty
      const manifestPath = join(dir, MARKER_FILENAME);
      await unlink(manifestPath).catch(() => {});
    } else {
      await writeManifest(dir, updated);
    }
  }
}

/**
 * Check if an entry is tracked in the manifest.
 */
export async function isInManifest(dir: string, entry: string): Promise<boolean> {
  const entries = await readManifest(dir);
  return entries.includes(entry);
}
