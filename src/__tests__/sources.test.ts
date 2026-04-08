import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveLocalSource,
  resolveSourcePath,
  syncSource,
  syncAllSources,
  removeStaleSourceDirs,
  ensureBridgeGitignore,
  cloneSource,
  fetchSource,
} from '../lib/sources.js';
import { type SourceConfig, type BridgeConfig, sourceDir, bridgeDir } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Create a bare git repo to act as a remote */
async function createBareRepo(dir: string): Promise<string> {
  const repoPath = join(dir, 'remote.git');
  await mkdir(repoPath, { recursive: true });
  execSync('git init --bare', { cwd: repoPath, stdio: 'pipe' });

  // Create a temporary working copy to push an initial commit
  const workPath = join(dir, 'work-tmp');
  await mkdir(workPath, { recursive: true });
  execSync(`git clone ${repoPath} ${workPath}`, { stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workPath, stdio: 'pipe' });
  await writeFile(join(workPath, 'README.md'), '# Test', 'utf-8');
  // Create domain structure
  await mkdir(join(workPath, 'shared', 'skills', 'foundation'), { recursive: true });
  await writeFile(join(workPath, 'shared', 'skills', 'foundation', 'SKILL.md'), '# Foundation', 'utf-8');
  execSync('git add -A && git commit -m "init"', { cwd: workPath, stdio: 'pipe' });
  execSync('git push', { cwd: workPath, stdio: 'pipe' });

  await rm(workPath, { recursive: true, force: true });
  return repoPath;
}

/** Create a local source directory */
async function createLocalSource(dir: string): Promise<string> {
  const sourcePath = join(dir, 'local-source');
  await mkdir(join(sourcePath, 'shared', 'skills', 'my-skill'), { recursive: true });
  await writeFile(join(sourcePath, 'shared', 'skills', 'my-skill', 'SKILL.md'), '# My Skill', 'utf-8');
  return sourcePath;
}

// ---------------------------------------------------------------------------
// resolveLocalSource
// ---------------------------------------------------------------------------

describe('resolveLocalSource', () => {
  it('returns absolute paths unchanged', () => {
    const source: SourceConfig = { name: 'x', source: '/absolute/path' };
    expect(resolveLocalSource('/repo', source)).toBe('/absolute/path');
  });

  it('resolves relative paths from repoRoot', () => {
    const source: SourceConfig = { name: 'x', source: './relative/path' };
    const result = resolveLocalSource('/repo', source);
    expect(result).toBe(join('/repo', 'relative', 'path'));
  });
});

// ---------------------------------------------------------------------------
// resolveSourcePath
// ---------------------------------------------------------------------------

describe('resolveSourcePath', () => {
  it('returns sourceDir for remote sources', () => {
    const source: SourceConfig = {
      name: 'hub',
      source: 'https://github.com/org/repo.git',
    };
    expect(resolveSourcePath('/repo', source)).toBe(sourceDir('/repo', 'hub'));
  });

  it('returns the local path for absolute local sources', () => {
    const source: SourceConfig = {
      name: 'local',
      source: '/my-local',
    };
    expect(resolveSourcePath('/repo', source)).toBe('/my-local');
  });
});

// ---------------------------------------------------------------------------
// syncSource — local
// ---------------------------------------------------------------------------

describe('syncSource (local)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-src-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns local action when path exists', async () => {
    const localPath = await createLocalSource(tmpDir);
    const source: SourceConfig = { name: 'local', source: localPath };
    const result = await syncSource(tmpDir, source);
    expect(result.action).toBe('local');
    expect(result.error).toBeUndefined();
  });

  it('returns error when local path does not exist', async () => {
    const source: SourceConfig = { name: 'local', source: '/nonexistent/path' };
    const result = await syncSource(tmpDir, source);
    expect(result.action).toBe('local');
    expect(result.error).toContain('does not exist');
    expect(result.error).toContain('/nonexistent/path');
    expect(result.error).toContain('config.yml');
  });
});

// ---------------------------------------------------------------------------
// syncSource — remote (clone & fetch)
// ---------------------------------------------------------------------------

describe('syncSource (remote)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-src-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('clones a remote source that does not exist yet', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const source: SourceConfig = {
      name: 'hub',
      source: `file://${bareRepo}`,
      branch: 'main',
    };
    const result = await syncSource(repoRoot, source);
    expect(result.action).toBe('cloned');
    expect(result.error).toBeUndefined();

    // Verify cloned files exist
    expect(await dirExists(sourceDir(repoRoot, 'hub'))).toBe(true);
    expect(
      await dirExists(join(sourceDir(repoRoot, 'hub'), 'shared', 'skills', 'foundation'))
    ).toBe(true);
  });

  it('updates (fetches) an already-cloned remote source', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const source: SourceConfig = {
      name: 'hub',
      source: `file://${bareRepo}`,
      branch: 'main',
    };

    // First clone
    await syncSource(repoRoot, source);

    // Second sync → should update
    const result = await syncSource(repoRoot, source);
    expect(result.action).toBe('updated');
    expect(result.error).toBeUndefined();
  });

  it('clones a remote source without a branch (uses remote default)', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const source: SourceConfig = {
      name: 'hub',
      source: `file://${bareRepo}`,
    };
    const result = await syncSource(repoRoot, source);
    expect(result.action).toBe('cloned');
    expect(result.error).toBeUndefined();

    expect(await dirExists(sourceDir(repoRoot, 'hub'))).toBe(true);
    expect(
      await dirExists(join(sourceDir(repoRoot, 'hub'), 'shared', 'skills', 'foundation'))
    ).toBe(true);
  });

  it('updates a remote source without a branch', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const source: SourceConfig = {
      name: 'hub',
      source: `file://${bareRepo}`,
    };

    await syncSource(repoRoot, source);

    const result = await syncSource(repoRoot, source);
    expect(result.action).toBe('updated');
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncAllSources
// ---------------------------------------------------------------------------

describe('syncAllSources', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-src-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('syncs multiple sources', async () => {
    const localPath = await createLocalSource(tmpDir);
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'remote-hub', source: `file://${bareRepo}`, branch: 'main' },
        { name: 'local-stuff', source: localPath },
      ],
    };

    const results = await syncAllSources(repoRoot, config);
    expect(results).toHaveLength(2);
    expect(results[0].action).toBe('cloned');
    expect(results[1].action).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// removeStaleSourceDirs
// ---------------------------------------------------------------------------

describe('removeStaleSourceDirs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-src-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes cloned source dirs not in config', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    // Clone a source
    const source: SourceConfig = { name: 'old-hub', source: `file://${bareRepo}`, branch: 'main' };
    await cloneSource(repoRoot, source);
    expect(await dirExists(sourceDir(repoRoot, 'old-hub'))).toBe(true);

    // Config no longer has old-hub
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'new-hub', source: 'https://github.com/org/new.git', branch: 'main' },
      ],
    };

    const removed = await removeStaleSourceDirs(repoRoot, config);
    expect(removed).toContain('old-hub');
    expect(await dirExists(sourceDir(repoRoot, 'old-hub'))).toBe(false);
  });

  it('does not remove dirs that are still in config', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const repoRoot = join(tmpDir, 'host');
    await mkdir(repoRoot, { recursive: true });

    const source: SourceConfig = { name: 'hub', source: `file://${bareRepo}`, branch: 'main' };
    await cloneSource(repoRoot, source);

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: `file://${bareRepo}`, branch: 'main' }],
    };

    const removed = await removeStaleSourceDirs(repoRoot, config);
    expect(removed).toHaveLength(0);
    expect(await dirExists(sourceDir(repoRoot, 'hub'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureBridgeGitignore
// ---------------------------------------------------------------------------

describe('ensureBridgeGitignore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-gi-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .gitignore that ignores everything except config.yml', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [],
    };

    await ensureBridgeGitignore(tmpDir, config);

    const giPath = join(bridgeDir(tmpDir), '.gitignore');
    const content = await readFile(giPath, 'utf-8');
    expect(content).toContain('*');
    expect(content).toContain('!config.yml');
    expect(content).toContain('!.gitignore');
  });
});
