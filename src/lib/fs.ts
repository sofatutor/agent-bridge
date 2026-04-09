import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
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
