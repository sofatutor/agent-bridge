import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, realpath as fsRealpath, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRepoRoot,
  isInGitRepo,
  getGitHooksDir,
  generateHookScript,
  hasAgentBridgeHook,
  installGitHooks,
  removeGitHooks,
  AGENT_BRIDGE_HOOKS,
} from '../lib/git.js';

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

// ---------------------------------------------------------------------------
// isInGitRepo
// ---------------------------------------------------------------------------

describe('isInGitRepo', () => {
  it('returns true when inside a git repo', () => {
    // The test itself runs inside the agent-bridge repo
    expect(isInGitRepo()).toBe(true);
  });

  it('returns false when not in a git repo', async () => {
    const tmpDir = await fsRealpath(await mkdtemp(join(tmpdir(), 'agent-bridge-git-')));
    try {
      expect(isInGitRepo(tmpDir)).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getGitHooksDir
// ---------------------------------------------------------------------------

describe('getGitHooksDir', () => {
  it('returns the correct hooks directory path', () => {
    expect(getGitHooksDir('/repo')).toBe(join('/repo', '.git', 'hooks'));
  });
});

// ---------------------------------------------------------------------------
// generateHookScript
// ---------------------------------------------------------------------------

describe('generateHookScript', () => {
  it('generates a valid shell script', () => {
    const script = generateHookScript();
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('# agent-bridge-hook');
    expect(script).toContain('agent-bridge update');
    expect(script).toContain('agent-bridge sync');
  });

  it('runs in background to avoid blocking', () => {
    const script = generateHookScript();
    expect(script).toContain('&');
    expect(script).toContain('>/dev/null 2>&1');
  });

  it('has fallback to npx', () => {
    const script = generateHookScript();
    expect(script).toContain('npx @sofatutor/agent-bridge');
  });
});

// ---------------------------------------------------------------------------
// hasAgentBridgeHook
// ---------------------------------------------------------------------------

describe('hasAgentBridgeHook', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsRealpath(await mkdtemp(join(tmpdir(), 'agent-bridge-hook-')));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true if hook has the marker', async () => {
    const hookPath = join(tmpDir, 'post-checkout');
    await writeFile(hookPath, generateHookScript(), 'utf-8');
    expect(await hasAgentBridgeHook(hookPath)).toBe(true);
  });

  it('returns false if hook does not have the marker', async () => {
    const hookPath = join(tmpDir, 'post-checkout');
    await writeFile(hookPath, '#!/bin/sh\necho "other hook"', 'utf-8');
    expect(await hasAgentBridgeHook(hookPath)).toBe(false);
  });

  it('returns false if hook does not exist', async () => {
    const hookPath = join(tmpDir, 'nonexistent');
    expect(await hasAgentBridgeHook(hookPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installGitHooks
// ---------------------------------------------------------------------------

describe('installGitHooks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsRealpath(await mkdtemp(join(tmpdir(), 'agent-bridge-install-')));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns errors when not in a git repo', async () => {
    const result = await installGitHooks(tmpDir);
    expect(result.errors.length).toBe(AGENT_BRIDGE_HOOKS.length);
    expect(result.errors[0].error).toContain('Not a git repository');
  });

  it('installs hooks in a git repo', async () => {
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });

    const result = await installGitHooks(tmpDir);
    
    expect(result.installed).toContain('post-checkout');
    expect(result.installed).toContain('post-merge');
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);

    // Verify hooks were created
    for (const hook of AGENT_BRIDGE_HOOKS) {
      const hookPath = join(tmpDir, '.git', 'hooks', hook);
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('# agent-bridge-hook');
    }
  });

  it('skips existing non-Agent-Bridge hooks without force', async () => {
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });

    // Create an existing hook
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(join(hooksDir, 'post-checkout'), '#!/bin/sh\necho "existing"', 'utf-8');

    const result = await installGitHooks(tmpDir);
    
    expect(result.skipped).toContain('post-checkout');
    expect(result.installed).toContain('post-merge');
    expect(result.errors).toHaveLength(0);
  });

  it('overwrites existing hooks with force flag', async () => {
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });

    // Create an existing hook
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(join(hooksDir, 'post-checkout'), '#!/bin/sh\necho "existing"', 'utf-8');

    const result = await installGitHooks(tmpDir, true);
    
    expect(result.installed).toContain('post-checkout');
    expect(result.installed).toContain('post-merge');
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('updates existing Agent-Bridge hooks', async () => {
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });

    // Create an existing Agent Bridge hook
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(join(hooksDir, 'post-checkout'), '#!/bin/sh\n# agent-bridge-hook\nold content', 'utf-8');

    const result = await installGitHooks(tmpDir);
    
    expect(result.installed).toContain('post-checkout');
    
    // Verify it was updated with new content
    const content = await readFile(join(hooksDir, 'post-checkout'), 'utf-8');
    expect(content).not.toContain('old content');
    expect(content).toContain('agent-bridge update');
  });
});

// ---------------------------------------------------------------------------
// removeGitHooks
// ---------------------------------------------------------------------------

describe('removeGitHooks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsRealpath(await mkdtemp(join(tmpdir(), 'agent-bridge-remove-')));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when not in a git repo', async () => {
    const result = await removeGitHooks(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('removes Agent-Bridge hooks', async () => {
    // Initialize a git repo and install hooks
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    await installGitHooks(tmpDir);

    const removed = await removeGitHooks(tmpDir);
    
    expect(removed).toContain('post-checkout');
    expect(removed).toContain('post-merge');

    // Verify hooks were removed
    for (const hook of AGENT_BRIDGE_HOOKS) {
      const hookPath = join(tmpDir, '.git', 'hooks', hook);
      let exists = true;
      try {
        await access(hookPath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }
  });

  it('does not remove non-Agent-Bridge hooks', async () => {
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });

    // Create a non-Agent-Bridge hook
    const hooksDir = join(tmpDir, '.git', 'hooks');
    await writeFile(join(hooksDir, 'post-checkout'), '#!/bin/sh\necho "custom"', 'utf-8');

    const removed = await removeGitHooks(tmpDir);
    
    expect(removed).not.toContain('post-checkout');

    // Verify hook still exists
    const content = await readFile(join(hooksDir, 'post-checkout'), 'utf-8');
    expect(content).toContain('custom');
  });
});
