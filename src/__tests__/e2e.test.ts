import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  lstat,
  readFile,
  access,
} from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveConfig,
  loadConfig,
  validateConfig,
  configPath,
  type BridgeConfig,
} from '../lib/config.js';
import { syncAllSources } from '../lib/sources.js';
import { discoverFeatureTypes, scanFeatures, detectDuplicates } from '../lib/manifest.js';
import { reconcileFeatures } from '../lib/symlinks.js';
import { hasMarker } from '../lib/fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createBareRepo(dir: string): Promise<string> {
  const repoPath = join(dir, 'remote.git');
  await mkdir(repoPath, { recursive: true });
  execSync('git init --bare', { cwd: repoPath, stdio: 'pipe' });

  const workPath = join(dir, 'work-tmp');
  await mkdir(workPath, { recursive: true });
  execSync(`git clone ${repoPath} ${workPath}`, { stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: workPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: workPath, stdio: 'pipe' });

  // Create domain/feature structure
  await mkdir(join(workPath, 'shared', 'skills', 'foundation'), { recursive: true });
  await writeFile(join(workPath, 'shared', 'skills', 'foundation', 'SKILL.md'), '# Foundation Skill', 'utf-8');

  await mkdir(join(workPath, 'shared', 'agents', 'helper'), { recursive: true });
  await writeFile(join(workPath, 'shared', 'agents', 'helper', 'AGENT.md'), '# Helper Agent', 'utf-8');

  await mkdir(join(workPath, 'shared', 'cursor--instructions', 'my-rule'), { recursive: true });
  await writeFile(join(workPath, 'shared', 'cursor--instructions', 'my-rule', 'RULE.md'), '# Cursor Rule', 'utf-8');

  await mkdir(join(workPath, 'backend', 'skills', 'deploy'), { recursive: true });
  await writeFile(join(workPath, 'backend', 'skills', 'deploy', 'SKILL.md'), '# Deploy Skill', 'utf-8');

  execSync('git add -A && git commit -m "init"', { cwd: workPath, stdio: 'pipe' });
  execSync('git push', { cwd: workPath, stdio: 'pipe' });

  await rm(workPath, { recursive: true, force: true });
  return repoPath;
}

async function createLocalSource(dir: string): Promise<string> {
  const sourcePath = join(dir, 'local-source');
  await mkdir(join(sourcePath, 'shared', 'skills', 'local-skill'), { recursive: true });
  await writeFile(
    join(sourcePath, 'shared', 'skills', 'local-skill', 'SKILL.md'),
    '# Local Skill',
    'utf-8'
  );
  return sourcePath;
}

// ---------------------------------------------------------------------------
// E2E: full init → sync → update → re-sync flow
// ---------------------------------------------------------------------------

describe('end-to-end integration', () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-e2e-'));
    repoRoot = join(tmpDir, 'host-repo');
    await mkdir(repoRoot, { recursive: true });
    // Init as git repo so findRepoRoot() would work
    execSync('git init', { cwd: repoRoot, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoRoot, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoRoot, stdio: 'pipe' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('full flow: save config → sync sources → discover → reconcile → re-sync', async () => {
    const bareRepo = await createBareRepo(tmpDir);
    const localPath = await createLocalSource(tmpDir);

    // --- Step 1: Create config ---
    const config: BridgeConfig = {
      domains: ['shared', 'backend'],
      tools: [
        { name: 'vscode', folder: '.github' },
        { name: 'cursor', folder: '.cursor' },
      ],
      sources: [
        { name: 'company-hub', source: `file://${bareRepo}`, branch: 'main' },
        { name: 'local-stuff', source: localPath },
      ],
    };

    await saveConfig(repoRoot, config);

    // Verify config was saved
    const loaded = await loadConfig(repoRoot);
    expect(loaded.domains).toEqual(['shared', 'backend']);
    expect(loaded.sources).toHaveLength(2);

    // Verify config validates
    const validation = validateConfig(loaded);
    expect(validation.ok).toBe(true);

    // --- Step 2: Sync sources ---
    const sourceResults = await syncAllSources(repoRoot, config);
    expect(sourceResults).toHaveLength(2);
    expect(sourceResults[0].action).toBe('cloned');
    expect(sourceResults[0].error).toBeUndefined();
    expect(sourceResults[1].action).toBe('local');

    // --- Step 3: Discover features ---
    const featureTypes = await discoverFeatureTypes(repoRoot, config);
    expect(featureTypes).toContain('skills');
    expect(featureTypes).toContain('agents');
    expect(featureTypes).toContain('cursor--instructions');

    const features = await scanFeatures(repoRoot, config, featureTypes);
    expect(features.length).toBeGreaterThanOrEqual(4);

    // Verify no duplicates
    const dups = detectDuplicates(features);
    expect(dups).toHaveLength(0);

    // --- Step 4: Reconcile features ---
    const result = await reconcileFeatures(repoRoot, config, features);
    expect(result.added).toBeGreaterThan(0);

    // Verify files were copied (not symlinks)
    const foundationFileVscode = join(repoRoot, '.github', 'skills', 'foundation', 'SKILL.md');
    const stats = await lstat(foundationFileVscode);
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);

    // Verify content was copied correctly
    const content = await readFile(foundationFileVscode, 'utf-8');
    expect(content).toBe('# Foundation Skill');

    // Verify marker exists
    expect(await hasMarker(join(repoRoot, '.github', 'skills', 'foundation'))).toBe(true);

    // Verify cursor-specific feature only in .cursor
    const cursorRuleFile = join(repoRoot, '.cursor', 'instructions', 'my-rule', 'RULE.md');
    const cursorContent = await readFile(cursorRuleFile, 'utf-8');
    expect(cursorContent).toBe('# Cursor Rule');

    // cursor--instructions should NOT appear in .github
    let vscodeInstructionsExists = false;
    try {
      await lstat(join(repoRoot, '.github', 'instructions', 'my-rule', 'RULE.md'));
      vscodeInstructionsExists = true;
    } catch {}
    expect(vscodeInstructionsExists).toBe(false);

    // Verify local source features are copied too
    const localSkillFile = join(repoRoot, '.github', 'skills', 'local-skill', 'SKILL.md');
    const localContent = await readFile(localSkillFile, 'utf-8');
    expect(localContent).toBe('# Local Skill');

    // Verify it's a real file, not a symlink
    const localStats = await lstat(localSkillFile);
    expect(localStats.isFile()).toBe(true);
    expect(localStats.isSymbolicLink()).toBe(false);

    // --- Step 5: Re-sync updates existing features ---
    const result2 = await reconcileFeatures(repoRoot, config, features);
    expect(result2.added).toBe(0);
    expect(result2.removed).toBe(0);
    // updated > 0 because file-copy always re-copies
    expect(result2.updated).toBeGreaterThan(0);

    // --- Step 6: Update sources ---
    const updateResults = await syncAllSources(repoRoot, config);
    expect(updateResults[0].action).toBe('updated');
    expect(updateResults[0].error).toBeUndefined();
  });

  it('detects duplicates across sources', async () => {
    const localPath1 = join(tmpDir, 'source1');
    const localPath2 = join(tmpDir, 'source2');

    // Both sources have shared/skills/foundation → conflict
    await mkdir(join(localPath1, 'shared', 'skills', 'foundation'), { recursive: true });
    await writeFile(join(localPath1, 'shared', 'skills', 'foundation', 'SKILL.md'), '# v1', 'utf-8');

    await mkdir(join(localPath2, 'shared', 'skills', 'foundation'), { recursive: true });
    await writeFile(join(localPath2, 'shared', 'skills', 'foundation', 'SKILL.md'), '# v2', 'utf-8');

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'source1', source: localPath1 },
        { name: 'source2', source: localPath2 },
      ],
    };

    await saveConfig(repoRoot, config);

    const featureTypes = await discoverFeatureTypes(repoRoot, config);
    const features = await scanFeatures(repoRoot, config, featureTypes);
    const dups = detectDuplicates(features);

    expect(dups).toHaveLength(1);
    expect(dups[0].name).toBe('foundation');
  });
});
