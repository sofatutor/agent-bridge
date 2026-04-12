import { stat, readdir, copyFile, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
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
