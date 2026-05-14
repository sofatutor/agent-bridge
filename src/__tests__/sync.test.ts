import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  featureDestPath,
  checkPathConflict,
  syncFolderFeature,
  syncFeature,
  removeEmptyParents,
  reconcileFeatures,
  syncRootFiles,
  isRootFileManaged,
  reconcileToolRootEntries,
} from '../lib/sync.js';
import { readManifest, MARKER_FILENAME } from '../lib/fs.js';
import type { BridgeConfig } from '../lib/config.js';
import type { Feature, RootFile, ToolRootEntry } from '../lib/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function featureStub(overrides: Partial<Feature> = {}): Feature {
  return {
    name: 'my-feature',
    type: 'skills',
    displayType: 'skills',
    source: 'hub',
    domain: 'shared',
    absolutePath: '/tmp/hub/shared/skills/my-feature',
    isFile: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// featureDestPath
// ---------------------------------------------------------------------------

describe('featureDestPath', () => {
  it('builds the destination path for a feature', () => {
    const dest = featureDestPath('/repo', '.github', 'skills', 'foundation');
    expect(dest).toBe('/repo/.github/skills/foundation');
  });
});

// ---------------------------------------------------------------------------
// checkPathConflict
// ---------------------------------------------------------------------------

describe('checkPathConflict', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-conflict-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent path', async () => {
    expect(await checkPathConflict(tmpDir, 'nope', false)).toBe(false);
  });

  it('returns true for a real directory without manifest entry', async () => {
    const d = join(tmpDir, 'real-dir');
    await mkdir(d);
    expect(await checkPathConflict(tmpDir, 'real-dir', false)).toBe(true);
  });

  it('returns false for a directory tracked in manifest', async () => {
    const d = join(tmpDir, 'managed-dir');
    await mkdir(d);
    await writeFile(join(tmpDir, MARKER_FILENAME), 'managed-dir/\n', 'utf-8');
    expect(await checkPathConflict(tmpDir, 'managed-dir', false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncFolderFeature
// ---------------------------------------------------------------------------

describe('syncFolderFeature', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-sync-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('copies files and adds to manifest for a new feature', async () => {
    const source = join(tmpDir, 'source-feature');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# My Skill', 'utf-8');

    const featureTypeDir = join(tmpDir, '.github', 'skills');
    const result = await syncFolderFeature(source, featureTypeDir, 'my-skill');
    expect(result).toBe('created');

    // File was copied
    const content = await readFile(join(featureTypeDir, 'my-skill', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# My Skill');

    // Manifest tracks the folder
    const manifest = await readManifest(featureTypeDir);
    expect(manifest).toContain('my-skill/');

    // It's a real file, not a symlink
    const stats = await lstat(join(featureTypeDir, 'my-skill', 'SKILL.md'));
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });

  it('returns "updated" when re-syncing an existing feature', async () => {
    const source = join(tmpDir, 'source-feature');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# V1', 'utf-8');

    const featureTypeDir = join(tmpDir, '.github', 'skills');
    await syncFolderFeature(source, featureTypeDir, 'my-skill');

    // Update source
    await writeFile(join(source, 'SKILL.md'), '# V2', 'utf-8');

    const result = await syncFolderFeature(source, featureTypeDir, 'my-skill');
    expect(result).toBe('updated');

    // New content is in place
    const content = await readFile(join(featureTypeDir, 'my-skill', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# V2');

    // Manifest still tracks the folder
    const manifest = await readManifest(featureTypeDir);
    expect(manifest).toContain('my-skill/');
  });

  it('copies nested directory structure', async () => {
    const source = join(tmpDir, 'source-feature');
    await mkdir(join(source, 'sub'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# Top', 'utf-8');
    await writeFile(join(source, 'sub', 'extra.md'), '# Sub', 'utf-8');

    const featureTypeDir = join(tmpDir, '.github', 'skills');
    await syncFolderFeature(source, featureTypeDir, 'my-skill');

    expect(await readFile(join(featureTypeDir, 'my-skill', 'SKILL.md'), 'utf-8')).toBe('# Top');
    expect(await readFile(join(featureTypeDir, 'my-skill', 'sub', 'extra.md'), 'utf-8')).toBe('# Sub');
  });
});

// ---------------------------------------------------------------------------
// reconcileFeatures (integration)
// ---------------------------------------------------------------------------

describe('reconcileFeatures', () => {
  let tmpDir: string;
  let sourceRoot: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-recon-'));
    sourceRoot = join(tmpDir, 'hub');
    repoRoot = tmpDir;

    // Create source features
    await mkdir(join(sourceRoot, 'shared', 'skills', 'foundation'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'skills', 'foundation', 'SKILL.md'),
      '# Foundation',
      'utf-8'
    );
    await mkdir(join(sourceRoot, 'shared', 'skills', 'deploy'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'skills', 'deploy', 'SKILL.md'),
      '# Deploy',
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates feature folders for new features', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };
    const features: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
      {
        name: 'deploy',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'deploy'),
        isFile: false,
      },
    ];

    const result = await reconcileFeatures(repoRoot, config, features);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);

    // Verify files were copied
    const content = await readFile(
      join(repoRoot, '.github', 'skills', 'foundation', 'SKILL.md'),
      'utf-8'
    );
    expect(content).toBe('# Foundation');

    // Verify manifest tracks the folder
    const manifest = await readManifest(join(repoRoot, '.github', 'skills'));
    expect(manifest).toContain('foundation/');
  });

  it('removes orphaned feature folders', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    // First reconcile with two features
    const allFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
      {
        name: 'deploy',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'deploy'),
        isFile: false,
      },
    ];
    await reconcileFeatures(repoRoot, config, allFeatures);

    // Second reconcile with only one feature → deploy should be removed
    const fewerFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
    ];
    const result = await reconcileFeatures(repoRoot, config, fewerFeatures);
    expect(result.removed).toBe(1);

    // deploy folder should be gone
    let deployExists = true;
    try {
      await access(join(repoRoot, '.github', 'skills', 'deploy'));
    } catch {
      deployExists = false;
    }
    expect(deployExists).toBe(false);
  });

  it('only creates features for matching tools', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [
        { name: 'vscode', folder: '.github' },
        { name: 'cursor', folder: '.cursor' },
      ],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    await mkdir(join(sourceRoot, 'shared', 'cursor--instructions', 'my-rule'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'cursor--instructions', 'my-rule', 'instructions.md'),
      '# Rule',
      'utf-8'
    );

    const features: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
      {
        name: 'my-rule',
        type: 'cursor--instructions',
        displayType: 'instructions',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(
          sourceRoot,
          'shared',
          'cursor--instructions',
          'my-rule'
        ),
        toolPrefix: 'cursor',
        isFile: false,
      },
    ];

    const result = await reconcileFeatures(repoRoot, config, features);
    // foundation → 2 tools, my-rule → cursor only = 3 total
    expect(result.added).toBe(3);

    // my-rule should exist in .cursor but not .github
    const cursorRule = join(repoRoot, '.cursor', 'instructions', 'my-rule', 'instructions.md');
    const content = await readFile(cursorRule, 'utf-8');
    expect(content).toBe('# Rule');
  });

  it('is idempotent (re-sync updates all features)', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };
    const features: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
    ];

    await reconcileFeatures(repoRoot, config, features);
    const result = await reconcileFeatures(repoRoot, config, features);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(0);
  });

  it('removes orphaned feature folders from feature types no longer in sources', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    // Create agents source dir
    await mkdir(join(sourceRoot, 'shared', 'agents', 'helper'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'agents', 'helper', 'AGENT.md'),
      '# Helper',
      'utf-8'
    );

    // First reconcile with skills + agents
    const allFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
      {
        name: 'helper',
        type: 'agents',
        displayType: 'agents',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'agents', 'helper'),
        isFile: false,
      },
    ];
    await reconcileFeatures(repoRoot, config, allFeatures);

    // Verify agent folder was created and tracked in manifest
    const agentsManifest = await readManifest(join(repoRoot, '.github', 'agents'));
    expect(agentsManifest).toContain('helper/');

    // Second reconcile with only skills (agents entirely removed)
    const fewerFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
        isFile: false,
      },
    ];
    const result = await reconcileFeatures(repoRoot, config, fewerFeatures);
    expect(result.removed).toBe(1);

    // agent folder and its empty parent dir should be gone
    let agentExists = true;
    try {
      await access(join(repoRoot, '.github', 'agents', 'helper'));
    } catch {
      agentExists = false;
    }
    expect(agentExists).toBe(false);
  });

  it('cleans up empty parent directories after removing features', async () => {
    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    // Create agents source
    await mkdir(join(sourceRoot, 'shared', 'agents', 'helper'), {
      recursive: true,
    });
    await writeFile(
      join(sourceRoot, 'shared', 'agents', 'helper', 'AGENT.md'),
      '# Helper',
      'utf-8'
    );

    // Reconcile with agents feature
    const features: Feature[] = [
      {
        name: 'helper',
        type: 'agents',
        displayType: 'agents',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'agents', 'helper'),
        isFile: false,
      },
    ];
    await reconcileFeatures(repoRoot, config, features);

    // Verify the dir exists
    const agentsDir = join(repoRoot, '.github', 'agents');
    expect((await lstat(agentsDir)).isDirectory()).toBe(true);

    // Reconcile with empty features → removes helper feature
    const result = await reconcileFeatures(repoRoot, config, []);
    expect(result.removed).toBe(1);

    // The agents/ directory should be cleaned up (empty)
    let agentsDirExists = true;
    try {
      await access(agentsDir);
    } catch {
      agentsDirExists = false;
    }
    expect(agentsDirExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeEmptyParents
// ---------------------------------------------------------------------------

describe('removeEmptyParents', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-empty-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes empty directories up to the stop point', async () => {
    const stopAt = join(tmpDir, 'root');
    const nested = join(stopAt, 'a', 'b');
    await mkdir(nested, { recursive: true });

    await removeEmptyParents(nested, stopAt);

    // Both a/ and a/b/ should be removed
    let aExists = true;
    try {
      await access(join(stopAt, 'a'));
    } catch {
      aExists = false;
    }
    expect(aExists).toBe(false);
    // stopAt itself should remain
    expect((await lstat(stopAt)).isDirectory()).toBe(true);
  });

  it('stops when a directory is not empty', async () => {
    const stopAt = join(tmpDir, 'root');
    const nested = join(stopAt, 'a', 'b');
    await mkdir(nested, { recursive: true });
    // Put a file in a/ so it's not empty after b/ is removed
    await writeFile(join(stopAt, 'a', 'keep.txt'), 'keep', 'utf-8');

    await removeEmptyParents(nested, stopAt);

    // b/ removed, a/ kept because it has keep.txt
    let bExists = true;
    try {
      await access(nested);
    } catch {
      bExists = false;
    }
    expect(bExists).toBe(false);
    expect((await lstat(join(stopAt, 'a'))).isDirectory()).toBe(true);
  });

  it('does nothing if the directory is not empty', async () => {
    const stopAt = join(tmpDir, 'root');
    const dir = join(stopAt, 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'file.txt'), 'data', 'utf-8');

    await removeEmptyParents(dir, stopAt);

    expect((await lstat(dir)).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncRootFiles
// ---------------------------------------------------------------------------

describe('syncRootFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sync-rootfiles-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('copies AGENTS.md to workspace root with managed marker', async () => {
    const sourceDir = join(tmpDir, 'source', 'shared');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# Agent instructions\n', 'utf-8');

    const rootFiles: RootFile[] = [{
      fileName: 'AGENTS.md',
      source: 'hub',
      domain: 'shared',
      absolutePath: join(sourceDir, 'AGENTS.md'),
    }];

    const result = await syncRootFiles(tmpDir, rootFiles);
    expect(result.synced).toEqual(['AGENTS.md']);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);

    const content = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('<!-- Managed by Agent Bridge -->');
    expect(content).toContain('# Agent instructions');
  });

  it('does not overwrite user-created root file (no marker)', async () => {
    // User created their own AGENTS.md
    await writeFile(join(tmpDir, 'AGENTS.md'), '# My custom agents\n', 'utf-8');

    const sourceDir = join(tmpDir, 'source', 'shared');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# From source\n', 'utf-8');

    const rootFiles: RootFile[] = [{
      fileName: 'AGENTS.md',
      source: 'hub',
      domain: 'shared',
      absolutePath: join(sourceDir, 'AGENTS.md'),
    }];

    const result = await syncRootFiles(tmpDir, rootFiles);
    expect(result.synced).toEqual([]);

    // User file should be untouched
    const content = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toBe('# My custom agents\n');
  });

  it('updates a managed root file', async () => {
    // Existing managed file
    await writeFile(join(tmpDir, 'AGENTS.md'), '<!-- Managed by Agent Bridge -->\n# Old content\n', 'utf-8');

    const sourceDir = join(tmpDir, 'source', 'shared');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# New content\n', 'utf-8');

    const rootFiles: RootFile[] = [{
      fileName: 'AGENTS.md',
      source: 'hub',
      domain: 'shared',
      absolutePath: join(sourceDir, 'AGENTS.md'),
    }];

    const result = await syncRootFiles(tmpDir, rootFiles);
    expect(result.synced).toEqual(['AGENTS.md']);

    const content = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# New content');
    expect(content).not.toContain('# Old content');
  });

  it('removes managed root files no longer in sources', async () => {
    // Existing managed file with no corresponding source
    await writeFile(join(tmpDir, 'AGENTS.md'), '<!-- Managed by Agent Bridge -->\n# Old\n', 'utf-8');

    const result = await syncRootFiles(tmpDir, []);
    expect(result.removed).toEqual(['AGENTS.md']);

    let exists = true;
    try { await access(join(tmpDir, 'AGENTS.md')); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('does not remove user-created root files when sources are empty', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# My custom agents\n', 'utf-8');

    const result = await syncRootFiles(tmpDir, []);
    expect(result.removed).toEqual([]);

    const content = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toBe('# My custom agents\n');
  });

  it('syncs multiple root files simultaneously', async () => {
    const sourceDir = join(tmpDir, 'source', 'shared');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# Agents\n', 'utf-8');
    await writeFile(join(sourceDir, 'CLAUDE.md'), '# Claude\n', 'utf-8');

    const rootFiles: RootFile[] = [
      {
        fileName: 'AGENTS.md',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'AGENTS.md'),
      },
      {
        fileName: 'CLAUDE.md',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'CLAUDE.md'),
      },
    ];

    const result = await syncRootFiles(tmpDir, rootFiles);
    expect(result.synced.sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(result.errors).toEqual([]);

    const agentsContent = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<!-- Managed by Agent Bridge -->');
    expect(agentsContent).toContain('# Agents');

    const claudeContent = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('<!-- Managed by Agent Bridge -->');
    expect(claudeContent).toContain('# Claude');
  });

  it('skips user file and syncs managed file in mixed scenario', async () => {
    // User-created AGENTS.md
    await writeFile(join(tmpDir, 'AGENTS.md'), '# My custom agents\n', 'utf-8');

    const sourceDir = join(tmpDir, 'source', 'shared');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'AGENTS.md'), '# From source agents\n', 'utf-8');
    await writeFile(join(sourceDir, 'CLAUDE.md'), '# From source claude\n', 'utf-8');

    const rootFiles: RootFile[] = [
      {
        fileName: 'AGENTS.md',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'AGENTS.md'),
      },
      {
        fileName: 'CLAUDE.md',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'CLAUDE.md'),
      },
    ];

    const result = await syncRootFiles(tmpDir, rootFiles);
    // AGENTS.md is user-created so skipped; CLAUDE.md is new so synced
    expect(result.synced).toEqual(['CLAUDE.md']);

    // User file untouched
    const agentsContent = await readFile(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toBe('# My custom agents\n');

    // CLAUDE.md synced with marker
    const claudeContent = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('<!-- Managed by Agent Bridge -->');
  });

  it('removes only managed files when multiple root files exist', async () => {
    // Managed AGENTS.md
    await writeFile(join(tmpDir, 'AGENTS.md'), '<!-- Managed by Agent Bridge -->\n# Old agents\n', 'utf-8');
    // User-created CLAUDE.md
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# My Claude\n', 'utf-8');

    const result = await syncRootFiles(tmpDir, []);
    expect(result.removed).toEqual(['AGENTS.md']);

    // AGENTS.md should be deleted
    let agentsExists = true;
    try { await access(join(tmpDir, 'AGENTS.md')); } catch { agentsExists = false; }
    expect(agentsExists).toBe(false);

    // User CLAUDE.md preserved
    const claudeContent = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toBe('# My Claude\n');
  });
});

// ---------------------------------------------------------------------------
// isRootFileManaged
// ---------------------------------------------------------------------------

describe('isRootFileManaged', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'managed-rootfile-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for a file with the managed marker', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '<!-- Managed by Agent Bridge -->\n# Content', 'utf-8');
    expect(await isRootFileManaged(join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('returns false for a user-created file', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# My instructions', 'utf-8');
    expect(await isRootFileManaged(join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('returns false for a non-existent file', async () => {
    expect(await isRootFileManaged(join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('returns false when marker is not on the first line', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Content\n<!-- Managed by Agent Bridge -->\n', 'utf-8');
    expect(await isRootFileManaged(join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('returns true for marker-only file', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '<!-- Managed by Agent Bridge -->', 'utf-8');
    expect(await isRootFileManaged(join(tmpDir, 'AGENTS.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileToolRootEntries
// ---------------------------------------------------------------------------

describe('reconcileToolRootEntries', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-toolroot-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeToolConfig = (): BridgeConfig => ({
    domains: ['shared'],
    tools: [
      { name: 'cursor', folder: '.cursor' },
      { name: 'vscode', folder: '.github' },
    ],
    sources: [{ name: 'hub', source: '/tmp/hub' }],
  });

  it('syncs a file entry to the tool root directory', async () => {
    const config = makeToolConfig();

    // Create source file
    const sourceDir = join(tmpDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'settings.json'), '{"key": "value"}', 'utf-8');

    const entries: ToolRootEntry[] = [
      {
        toolName: 'cursor',
        name: 'settings.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'settings.json'),
        isFile: true,
      },
    ];

    const result = await reconcileToolRootEntries(tmpDir, config, entries);
    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify file was synced
    const destContent = await readFile(join(tmpDir, '.cursor', 'settings.json'), 'utf-8');
    expect(destContent).toBe('{"key": "value"}');

    // Verify manifest entry
    const manifest = await readManifest(join(tmpDir, '.cursor'));
    expect(manifest).toContain('settings.json');
  });

  it('syncs a folder entry to the tool root directory', async () => {
    const config = makeToolConfig();

    // Create source folder
    const sourceDir = join(tmpDir, 'source', 'rules');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'review.md'), '# Review rules', 'utf-8');

    const entries: ToolRootEntry[] = [
      {
        toolName: 'cursor',
        name: 'rules',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(tmpDir, 'source', 'rules'),
        isFile: false,
      },
    ];

    const result = await reconcileToolRootEntries(tmpDir, config, entries);
    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify folder was synced
    const destContent = await readFile(join(tmpDir, '.cursor', 'rules', 'review.md'), 'utf-8');
    expect(destContent).toBe('# Review rules');

    // Verify manifest entry (folders have trailing /)
    const manifest = await readManifest(join(tmpDir, '.cursor'));
    expect(manifest).toContain('rules/');
  });

  it('removes orphaned entries not in expected list', async () => {
    const config = makeToolConfig();

    // Create tool dir with a previously managed file
    const toolDir = join(tmpDir, '.cursor');
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, 'old-config.json'), '{}', 'utf-8');
    await writeFile(join(toolDir, MARKER_FILENAME), 'old-config.json\n', 'utf-8');

    // No entries expected
    const result = await reconcileToolRootEntries(tmpDir, config, []);
    expect(result.removed).toBe(1);

    // File should be gone
    let exists = true;
    try { await access(join(toolDir, 'old-config.json')); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('syncs entries to different tools', async () => {
    const config = makeToolConfig();

    const sourceDir = join(tmpDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'cursor.json'), '{"cursor": true}', 'utf-8');
    await writeFile(join(sourceDir, 'vscode.json'), '{"vscode": true}', 'utf-8');

    const entries: ToolRootEntry[] = [
      {
        toolName: 'cursor',
        name: 'cursor.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'cursor.json'),
        isFile: true,
      },
      {
        toolName: 'vscode',
        name: 'vscode.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'vscode.json'),
        isFile: true,
      },
    ];

    const result = await reconcileToolRootEntries(tmpDir, config, entries);
    expect(result.added).toBe(2);

    const cursorContent = await readFile(join(tmpDir, '.cursor', 'cursor.json'), 'utf-8');
    expect(cursorContent).toBe('{"cursor": true}');

    const vscodeContent = await readFile(join(tmpDir, '.github', 'vscode.json'), 'utf-8');
    expect(vscodeContent).toBe('{"vscode": true}');
  });

  it('updates existing managed entries', async () => {
    const config = makeToolConfig();

    // First sync
    const sourceDir = join(tmpDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'config.json'), '{"v": 1}', 'utf-8');

    const entries: ToolRootEntry[] = [
      {
        toolName: 'cursor',
        name: 'config.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceDir, 'config.json'),
        isFile: true,
      },
    ];

    await reconcileToolRootEntries(tmpDir, config, entries);

    // Update source and re-sync
    await writeFile(join(sourceDir, 'config.json'), '{"v": 2}', 'utf-8');
    const result = await reconcileToolRootEntries(tmpDir, config, entries);
    expect(result.updated).toBe(1);

    const content = await readFile(join(tmpDir, '.cursor', 'config.json'), 'utf-8');
    expect(content).toBe('{"v": 2}');
  });
});
