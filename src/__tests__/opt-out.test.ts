import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, type BridgeConfig } from '../lib/config.js';
import { syncCommand } from '../commands/sync.js';
import { optOutCommand } from '../commands/opt-out.js';
import { installGitHooks } from '../lib/git.js';

describe('optOutCommand', () => {
  let tmpDir: string;
  let repoRoot: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-opt-out-'));
    repoRoot = join(tmpDir, 'repo');
    sourceRoot = join(tmpDir, 'source');

    await mkdir(repoRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });

    execSync('git init', { cwd: repoRoot, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoRoot, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoRoot, stdio: 'pipe' });

    await mkdir(join(sourceRoot, 'shared', 'skills', 'foundation'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'skills', 'foundation', 'SKILL.md'),
      '# Foundation Skill',
      'utf-8'
    );

    await writeFile(join(sourceRoot, 'shared', 'AGENTS.md'), '# Team Agents', 'utf-8');
    await writeFile(
      join(sourceRoot, 'shared', 'cursor--settings.json'),
      '{"from":"source"}',
      'utf-8'
    );

    // User-owned file that should remain.
    await mkdir(join(repoRoot, '.github', 'skills'), { recursive: true });
    await writeFile(
      join(repoRoot, '.github', 'skills', 'user-note.md'),
      '# Do not remove',
      'utf-8'
    );

    const config: BridgeConfig = {
      version: '0.10.0',
      domains: ['shared'],
      tools: [
        { name: 'vscode', folder: '.github' },
        { name: 'cursor', folder: '.cursor' },
      ],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    await saveConfig(repoRoot, config);
    await syncCommand(repoRoot);
    await installGitHooks(repoRoot);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes managed synced outputs, hooks, and .agent-bridge directory', async () => {
    // Sanity-check preconditions
    await access(join(repoRoot, '.github', 'skills', 'foundation', 'SKILL.md'));
    await access(join(repoRoot, 'AGENTS.md'));
    await access(join(repoRoot, '.cursor', 'settings.json'));
    await access(join(repoRoot, '.git', 'hooks', 'post-checkout'));
    await access(join(repoRoot, '.agent-bridge', 'config.yml'));

    await optOutCommand(repoRoot);

    let exists = true;
    try {
      await access(join(repoRoot, '.github', 'skills', 'foundation', 'SKILL.md'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    exists = true;
    try {
      await access(join(repoRoot, 'AGENTS.md'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);

    exists = true;
    try {
      await access(join(repoRoot, '.cursor', 'settings.json'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    exists = true;
    try {
      await access(join(repoRoot, '.git', 'hooks', 'post-checkout'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    exists = true;
    try {
      await access(join(repoRoot, '.git', 'hooks', 'post-merge'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    exists = true;
    try {
      await access(join(repoRoot, '.agent-bridge'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    const userOwned = await readFile(
      join(repoRoot, '.github', 'skills', 'user-note.md'),
      'utf-8'
    );
    expect(userOwned).toBe('# Do not remove');
    
    const rootFile = await readFile(join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(rootFile).toContain('Managed by Agent Bridge');
  });

  it('preserves non-Agent-Bridge hooks', async () => {
    await writeFile(
      join(repoRoot, '.git', 'hooks', 'post-merge'),
      '#!/bin/sh\necho custom hook\n',
      'utf-8'
    );

    await optOutCommand(repoRoot);

    const customHook = await readFile(
      join(repoRoot, '.git', 'hooks', 'post-merge'),
      'utf-8'
    );
    expect(customHook).toContain('custom hook');
  });
});
