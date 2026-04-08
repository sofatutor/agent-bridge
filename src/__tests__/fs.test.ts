import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirExists } from '../lib/fs.js';

describe('dirExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-fs-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for an existing directory', async () => {
    const dir = join(tmpDir, 'my-dir');
    await mkdir(dir);
    expect(await dirExists(dir)).toBe(true);
  });

  it('returns false for a non-existent path', async () => {
    expect(await dirExists(join(tmpDir, 'nope'))).toBe(false);
  });

  it('returns false for a regular file (not a directory)', async () => {
    const file = join(tmpDir, 'a-file');
    await writeFile(file, 'hello', 'utf-8');
    expect(await dirExists(file)).toBe(false);
  });

  it('returns true for nested directories', async () => {
    const nested = join(tmpDir, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    expect(await dirExists(nested)).toBe(true);
  });
});
