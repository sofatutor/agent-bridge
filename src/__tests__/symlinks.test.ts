import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile, readlink, lstat, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import {
  resolveRelativePath,
  buildSymlinkEntry,
  checkPathConflict,
  createSymlink,
  removeSymlink,
  isSymlinkValid,
  removeEmptyParents,
  reconcileSymlinks,
} from '../lib/symlinks.js';
import type { BridgeConfig } from '../lib/config.js';
import type { Feature } from '../lib/manifest.js';

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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveRelativePath
// ---------------------------------------------------------------------------

describe('resolveRelativePath', () => {
  it('computes relative path from link to target', () => {
    const from = '/repo/.github/skills/foundation';
    const to = '/repo/.agent-bridge/hub/shared/skills/foundation';
    const rel = resolveRelativePath(from, to);
    expect(rel).toBe(
      relative(dirname(from), to)
    );
  });
});

// ---------------------------------------------------------------------------
// buildSymlinkEntry
// ---------------------------------------------------------------------------

describe('buildSymlinkEntry', () => {
  it('builds a symlink entry with absolute target', () => {
    const entry = buildSymlinkEntry(
      '/repo',
      '.github',
      'skills',
      'foundation',
      '/repo/.agent-bridge/hub/shared/skills/foundation'
    );
    expect(entry.linkPath).toBe('/repo/.github/skills/foundation');
    expect(entry.targetPath).toBe(
      '/repo/.agent-bridge/hub/shared/skills/foundation'
    );
  });
});

// ---------------------------------------------------------------------------
// checkPathConflict
// ---------------------------------------------------------------------------

describe('checkPathConflict', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-sym-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent path', async () => {
    expect(await checkPathConflict(join(tmpDir, 'nope'))).toBe(false);
  });

  it('returns true for a real file', async () => {
    const f = join(tmpDir, 'real-file');
    await writeFile(f, 'hello', 'utf-8');
    expect(await checkPathConflict(f)).toBe(true);
  });

  it('returns true for a real directory', async () => {
    const d = join(tmpDir, 'real-dir');
    await mkdir(d);
    expect(await checkPathConflict(d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSymlink / isSymlinkValid / removeSymlink
// ---------------------------------------------------------------------------

describe('createSymlink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-sym-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new symlink and returns "created"', async () => {
    const target = join(tmpDir, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), '# Skill', 'utf-8');

    const linkPath = join(tmpDir, '.github', 'skills', 'my-skill');
    const entry = { linkPath, targetPath: target };

    const result = await createSymlink(entry);
    expect(result).toBe('created');

    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);

    const linkTarget = await readlink(linkPath);
    const expectedRel = relative(dirname(linkPath), target);
    expect(linkTarget).toBe(expectedRel);
  });

  it('returns "updated" when symlink already points to correct target', async () => {
    const target = join(tmpDir, 'target');
    await mkdir(target, { recursive: true });

    const linkPath = join(tmpDir, '.github', 'skills', 'my-skill');
    const entry = { linkPath, targetPath: target };

    await createSymlink(entry);
    const result = await createSymlink(entry);
    expect(result).toBe('updated');
  });

  it('updates symlink when target changes', async () => {
    const target1 = join(tmpDir, 'target1');
    const target2 = join(tmpDir, 'target2');
    await mkdir(target1, { recursive: true });
    await mkdir(target2, { recursive: true });

    const linkPath = join(tmpDir, '.github', 'skills', 'my-skill');

    await createSymlink({ linkPath, targetPath: target1 });
    const result = await createSymlink({ linkPath, targetPath: target2 });
    expect(result).toBe('updated');

    const linkTarget = await readlink(linkPath);
    const expectedRel = relative(dirname(linkPath), target2);
    expect(linkTarget).toBe(expectedRel);
  });

  it('throws on path conflict (real file exists)', async () => {
    const linkPath = join(tmpDir, '.github', 'skills', 'my-skill');
    await mkdir(dirname(linkPath), { recursive: true });
    await writeFile(linkPath, 'I am a real file', 'utf-8');

    const entry = { linkPath, targetPath: join(tmpDir, 'target') };
    await expect(createSymlink(entry)).rejects.toThrow('Path conflict');
  });
});

describe('isSymlinkValid', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-sym-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for valid symlink', async () => {
    const target = join(tmpDir, 'target');
    await mkdir(target, { recursive: true });
    const linkPath = join(tmpDir, 'link');
    await createSymlink({ linkPath, targetPath: target });

    expect(await isSymlinkValid(linkPath, target)).toBe(true);
  });

  it('returns false for non-existent path', async () => {
    expect(await isSymlinkValid(join(tmpDir, 'nope'), '/target')).toBe(false);
  });

  it('returns false when target differs', async () => {
    const target1 = join(tmpDir, 'target1');
    const target2 = join(tmpDir, 'target2');
    await mkdir(target1, { recursive: true });
    await mkdir(target2, { recursive: true });
    const linkPath = join(tmpDir, 'link');
    await createSymlink({ linkPath, targetPath: target1 });

    expect(await isSymlinkValid(linkPath, target2)).toBe(false);
  });
});

describe('removeSymlink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-sym-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes a symlink', async () => {
    const target = join(tmpDir, 'target');
    await mkdir(target, { recursive: true });
    const linkPath = join(tmpDir, 'link');
    await createSymlink({ linkPath, targetPath: target });

    await removeSymlink(linkPath);
    await expect(lstat(linkPath)).rejects.toThrow();
  });

  it('does nothing for non-existent path', async () => {
    await removeSymlink(join(tmpDir, 'nope'));
    // no throw = pass
  });
});

// ---------------------------------------------------------------------------
// reconcileSymlinks (integration)
// ---------------------------------------------------------------------------

describe('reconcileSymlinks', () => {
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

  it('creates symlinks for new features', async () => {
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
      },
      {
        name: 'deploy',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'deploy'),
      },
    ];

    const result = await reconcileSymlinks(repoRoot, config, features);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);

    // Verify symlinks
    const link = join(repoRoot, '.github', 'skills', 'foundation', 'SKILL.md');
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
  });

  it('removes orphaned symlinks', async () => {
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
      },
      {
        name: 'deploy',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'deploy'),
      },
    ];
    await reconcileSymlinks(repoRoot, config, allFeatures);

    // Second reconcile with only one feature → deploy should be removed
    const fewerFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
      },
    ];
    const result = await reconcileSymlinks(repoRoot, config, fewerFeatures);
    expect(result.removed).toBe(1);

    // deploy link should be gone
    await expect(
      lstat(join(repoRoot, '.github', 'skills', 'deploy'))
    ).rejects.toThrow();
  });

  it('only creates symlinks for matching tools', async () => {
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
      },
    ];

    const result = await reconcileSymlinks(repoRoot, config, features);
    // foundation → 2 tools, my-rule → cursor only = 3 total
    expect(result.added).toBe(3);

    // my-rule should exist in .cursor but not .github
    const cursorLink = join(repoRoot, '.cursor', 'instructions', 'my-rule', 'instructions.md');
    expect((await lstat(cursorLink)).isSymbolicLink()).toBe(true);
  });

  it('is idempotent (no changes on second run)', async () => {
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
      },
    ];

    await reconcileSymlinks(repoRoot, config, features);
    const result = await reconcileSymlinks(repoRoot, config, features);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('removes orphaned symlinks from feature types no longer in sources', async () => {
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
      },
      {
        name: 'helper',
        type: 'agents',
        displayType: 'agents',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'agents', 'helper'),
      },
    ];
    await reconcileSymlinks(repoRoot, config, allFeatures);

    // Verify agent symlink was created
    const agentLink = join(repoRoot, '.github', 'agents', 'helper', 'AGENT.md');
    expect((await lstat(agentLink)).isSymbolicLink()).toBe(true);

    // Second reconcile with only skills (agents entirely removed)
    const fewerFeatures: Feature[] = [
      {
        name: 'foundation',
        type: 'skills',
        displayType: 'skills',
        source: 'hub',
        domain: 'shared',
        absolutePath: join(sourceRoot, 'shared', 'skills', 'foundation'),
      },
    ];
    const result = await reconcileSymlinks(repoRoot, config, fewerFeatures);
    expect(result.removed).toBe(1);

    // agent symlink and its empty parent dir should be gone
    await expect(lstat(agentLink)).rejects.toThrow();
  });

  it('cleans up empty parent directories after removing symlinks', async () => {
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
      },
    ];
    await reconcileSymlinks(repoRoot, config, features);

    // Verify the dir exists
    const agentsDir = join(repoRoot, '.github', 'agents');
    expect((await lstat(agentsDir)).isDirectory()).toBe(true);

    // Reconcile with empty features → removes helper symlink
    const result = await reconcileSymlinks(repoRoot, config, []);
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
