import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../lib/git.js';

describe('findRepoRoot', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('returns the git root when inside a git repo', () => {
    // The test itself runs inside the agent-bridge repo
    const root = findRepoRoot();
    expect(root).toBeTruthy();
    expect(typeof root).toBe('string');
  });

  it('falls back to process.cwd() when not in a git repo', async () => {
    const tmpDir = await fsRealpath(await mkdtemp(join(tmpdir(), 'agent-bridge-git-')));
    try {
      process.chdir(tmpDir);
      const root = findRepoRoot();
      expect(root).toBe(tmpDir);
    } finally {
      process.chdir(originalCwd);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
