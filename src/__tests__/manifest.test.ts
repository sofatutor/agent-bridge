import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseToolPrefix,
  featureMatchesTool,
  featureName,
  discoverFeatureTypes,
  scanFeatures,
  detectDuplicates,
  scanRootFiles,
  detectRootFileDuplicates,
  scanToolRootEntries,
  detectToolRootDuplicates,
  type Feature,
} from '../lib/manifest.js';
import type { BridgeConfig } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<BridgeConfig> & { _localSourcePath?: string } = {}
): BridgeConfig & { _localSourcePath?: string } {
  return {
    domains: ['shared', 'backend'],
    tools: [
      { name: 'vscode', folder: '.github' },
      { name: 'cursor', folder: '.cursor' },
    ],
    sources: [
      { name: 'hub', source: overrides._localSourcePath ?? '/tmp/hub' },
    ],
    ...overrides,
  };
}

/** Create a source directory tree on disk */
async function buildSourceTree(
  root: string,
  tree: Record<string, string[]>
): Promise<void> {
  for (const [dir, files] of Object.entries(tree)) {
    const dirPath = join(root, dir);
    await mkdir(dirPath, { recursive: true });
    for (const file of files) {
      await writeFile(join(dirPath, file), '', 'utf-8');
    }
  }
}

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
// parseToolPrefix
// ---------------------------------------------------------------------------

describe('parseToolPrefix', () => {
  it('returns baseName when no prefix', () => {
    expect(parseToolPrefix('foundation')).toEqual({ baseName: 'foundation' });
  });

  it('parses tool prefix with double dash', () => {
    expect(parseToolPrefix('cursor--instructions')).toEqual({
      toolPrefix: 'cursor',
      baseName: 'instructions',
    });
  });

  it('handles feature-level prefix', () => {
    expect(parseToolPrefix('vscode--my-prompt')).toEqual({
      toolPrefix: 'vscode',
      baseName: 'my-prompt',
    });
  });

  it('does not split on single dash', () => {
    expect(parseToolPrefix('my-skill')).toEqual({ baseName: 'my-skill' });
  });

  it('does not split on leading double dash', () => {
    // '--foo' has idx 0, not > 0
    expect(parseToolPrefix('--foo')).toEqual({ baseName: '--foo' });
  });
});

// ---------------------------------------------------------------------------
// featureMatchesTool
// ---------------------------------------------------------------------------

describe('featureMatchesTool', () => {
  it('matches when no tool prefix (universal feature)', () => {
    const f = featureStub({ toolPrefix: undefined });
    expect(featureMatchesTool(f, 'cursor')).toBe(true);
    expect(featureMatchesTool(f, 'vscode')).toBe(true);
  });

  it('matches when tool prefix equals tool name', () => {
    const f = featureStub({ toolPrefix: 'cursor' });
    expect(featureMatchesTool(f, 'cursor')).toBe(true);
  });

  it('does not match when tool prefix differs', () => {
    const f = featureStub({ toolPrefix: 'cursor' });
    expect(featureMatchesTool(f, 'vscode')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncName
// ---------------------------------------------------------------------------

describe('featureName', () => {
  it('returns the raw name when no prefix', () => {
    const f = featureStub({ name: 'foundation', toolPrefix: undefined });
    expect(featureName(f)).toBe('foundation');
  });

  it('strips the tool prefix', () => {
    const f = featureStub({ name: 'cursor--code-review', toolPrefix: 'cursor' });
    expect(featureName(f)).toBe('code-review');
  });
});

// ---------------------------------------------------------------------------
// discoverFeatureTypes — filesystem
// ---------------------------------------------------------------------------

describe('discoverFeatureTypes', () => {
  let tmpDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-disc-'));
    sourceRoot = join(tmpDir, 'hub');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers feature types across domains', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
      'shared/agents/helper': ['AGENT.md'],
      'backend/skills/deploy': ['SKILL.md'],
    });

    const config = makeConfig({
      _localSourcePath: sourceRoot,
      sources: [{ name: 'hub', source: sourceRoot }],
    });
    const types = await discoverFeatureTypes(tmpDir, config);
    expect(types).toEqual(['agents', 'skills']);
  });

  it('discovers tool-prefixed feature types', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
      'shared/cursor--instructions/my-rule': ['RULE.md'],
    });

    const config = makeConfig({
      sources: [{ name: 'hub', source: sourceRoot }],
    });
    const types = await discoverFeatureTypes(tmpDir, config);
    expect(types).toContain('cursor--instructions');
    expect(types).toContain('skills');
  });

  it('returns empty when no domains exist', async () => {
    await mkdir(sourceRoot, { recursive: true });
    const config = makeConfig({
      sources: [{ name: 'hub', source: sourceRoot }],
    });
    const types = await discoverFeatureTypes(tmpDir, config);
    expect(types).toEqual([]);
  });

  it('discovers across multiple sources', async () => {
    const source2 = join(tmpDir, 'extra');
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
    });
    await buildSourceTree(source2, {
      'shared/agents/helper': ['AGENT.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'hub', source: sourceRoot },
        { name: 'extra', source: source2 },
      ],
    };

    const types = await discoverFeatureTypes(tmpDir, config);
    expect(types).toEqual(['agents', 'skills']);
  });
});

// ---------------------------------------------------------------------------
// scanFeatures — filesystem
// ---------------------------------------------------------------------------

describe('scanFeatures', () => {
  let tmpDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-scan-'));
    sourceRoot = join(tmpDir, 'hub');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('scans features from source/domain/type/feature', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
      'backend/skills/deploy': ['SKILL.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared', 'backend'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    const features = await scanFeatures(tmpDir, config, ['skills']);
    expect(features).toHaveLength(2);

    const names = features.map((f) => f.name).sort();
    expect(names).toEqual(['deploy', 'foundation']);

    const foundation = features.find((f) => f.name === 'foundation')!;
    expect(foundation.source).toBe('hub');
    expect(foundation.domain).toBe('shared');
    expect(foundation.displayType).toBe('skills');
    expect(foundation.toolPrefix).toBeUndefined();
  });

  it('parses tool prefix at feature-type level', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/cursor--instructions/my-rule': ['RULE.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'cursor', folder: '.cursor' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    const features = await scanFeatures(tmpDir, config, [
      'cursor--instructions',
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].toolPrefix).toBe('cursor');
    expect(features[0].displayType).toBe('instructions');
  });

  it('parses tool prefix at feature level', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/cursor--code-review': ['SKILL.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'cursor', folder: '.cursor' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    const features = await scanFeatures(tmpDir, config, ['skills']);
    expect(features).toHaveLength(1);
    expect(features[0].toolPrefix).toBe('cursor');
    expect(features[0].name).toBe('cursor--code-review');
  });

  it('scans across multiple sources', async () => {
    const source2 = join(tmpDir, 'extra');
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
    });
    await buildSourceTree(source2, {
      'shared/skills/extra-skill': ['SKILL.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'hub', source: sourceRoot },
        { name: 'extra', source: source2 },
      ],
    };

    const features = await scanFeatures(tmpDir, config, ['skills']);
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.source).sort()).toEqual(['extra', 'hub']);
  });

  it('includes both file and folder entries', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/foundation': ['SKILL.md'],
    });
    // Add a file directly in the feature type dir
    await writeFile(
      join(sourceRoot, 'shared', 'skills', 'README.md'),
      '# Readme',
      'utf-8'
    );

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: sourceRoot }],
    };

    const features = await scanFeatures(tmpDir, config, ['skills']);
    expect(features).toHaveLength(2);
    
    const folder = features.find(f => f.name === 'foundation');
    const file = features.find(f => f.name === 'README.md');
    
    expect(folder).toBeDefined();
    expect(folder!.isFile).toBe(false);
    
    expect(file).toBeDefined();
    expect(file!.isFile).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectDuplicates
// ---------------------------------------------------------------------------

describe('detectDuplicates', () => {
  it('returns empty when no duplicates', () => {
    const features: Feature[] = [
      featureStub({ name: 'a', displayType: 'skills' }),
      featureStub({ name: 'b', displayType: 'skills' }),
    ];
    expect(detectDuplicates(features)).toHaveLength(0);
  });

  it('detects duplicates within the same display type', () => {
    const features: Feature[] = [
      featureStub({
        name: 'deploy',
        displayType: 'skills',
        source: 'hub',
        absolutePath: '/a',
      }),
      featureStub({
        name: 'deploy',
        displayType: 'skills',
        source: 'extra',
        absolutePath: '/b',
      }),
    ];
    const dups = detectDuplicates(features);
    expect(dups).toHaveLength(1);
    expect(dups[0].name).toBe('deploy');
    expect(dups[0].paths).toEqual(['/a', '/b']);
  });

  it('does not flag same name in different feature types', () => {
    const features: Feature[] = [
      featureStub({ name: 'deploy', displayType: 'skills' }),
      featureStub({ name: 'deploy', displayType: 'agents' }),
    ];
    expect(detectDuplicates(features)).toHaveLength(0);
  });

  it('detects duplicates after tool-prefix stripping', () => {
    const features: Feature[] = [
      featureStub({
        name: 'cursor--code-review',
        displayType: 'skills',
        toolPrefix: 'cursor',
        absolutePath: '/a',
      }),
      featureStub({
        name: 'code-review',
        displayType: 'skills',
        absolutePath: '/b',
      }),
    ];
    const dups = detectDuplicates(features);
    expect(dups).toHaveLength(1);
    expect(dups[0].name).toBe('code-review');
  });
});

// ---------------------------------------------------------------------------
// scanRootFiles
// ---------------------------------------------------------------------------

describe('scanRootFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manifest-rootfiles-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds AGENTS.md in domain root', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].fileName).toBe('AGENTS.md');
    expect(rootFiles[0].domain).toBe('shared');
    expect(rootFiles[0].source).toBe('hub');
  });

  it('finds CLAUDE.md in domain root', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['CLAUDE.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].fileName).toBe('CLAUDE.md');
  });

  it('finds both AGENTS.md and CLAUDE.md', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md', 'CLAUDE.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(2);
    const names = rootFiles.map((r) => r.fileName).sort();
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('returns empty for domains without root files', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared/skills/my-skill': ['README.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(0);
  });

  it('only scans configured domains', async () => {
    const config = makeConfig({
      _localSourcePath: tmpDir,
      domains: ['shared'],
    });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md'],
      'backend': ['AGENTS.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].domain).toBe('shared');
  });

  it('ignores non-root-file .md files', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['README.md', 'AGENTS.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].fileName).toBe('AGENTS.md');
  });

  it('scans root files across multiple sources', async () => {
    const source2 = join(tmpDir, 'extra');
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md'],
    });
    await buildSourceTree(source2, {
      'shared': ['CLAUDE.md'],
    });

    const config: BridgeConfig = {
      domains: ['shared'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'hub', source: tmpDir },
        { name: 'extra', source: source2 },
      ],
    };

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(2);
    const names = rootFiles.map((r) => r.fileName).sort();
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(rootFiles.find((r) => r.fileName === 'AGENTS.md')!.source).toBe('hub');
    expect(rootFiles.find((r) => r.fileName === 'CLAUDE.md')!.source).toBe('extra');
  });

  it('scans root files across multiple domains', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md'],
      'backend': ['CLAUDE.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(2);

    const agents = rootFiles.find((r) => r.fileName === 'AGENTS.md')!;
    expect(agents.domain).toBe('shared');

    const claude = rootFiles.find((r) => r.fileName === 'CLAUDE.md')!;
    expect(claude.domain).toBe('backend');
  });

  it('returns correct absolutePath for root files', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles[0].absolutePath).toBe(join(tmpDir, 'shared', 'AGENTS.md'));
  });
});

// ---------------------------------------------------------------------------
// detectRootFileDuplicates
// ---------------------------------------------------------------------------

describe('detectRootFileDuplicates', () => {
  it('detects same root file from multiple domains', () => {
    const rootFiles = [
      { fileName: 'AGENTS.md' as const, source: 'hub', domain: 'shared', absolutePath: '/a' },
      { fileName: 'AGENTS.md' as const, source: 'hub', domain: 'backend', absolutePath: '/b' },
    ];
    const dups = detectRootFileDuplicates(rootFiles);
    expect(dups).toHaveLength(1);
    expect(dups[0].fileName).toBe('AGENTS.md');
    expect(dups[0].paths).toEqual(['/a', '/b']);
  });

  it('allows different root files from same domain', () => {
    const rootFiles = [
      { fileName: 'AGENTS.md' as const, source: 'hub', domain: 'shared', absolutePath: '/a' },
      { fileName: 'CLAUDE.md' as const, source: 'hub', domain: 'shared', absolutePath: '/b' },
    ];
    const dups = detectRootFileDuplicates(rootFiles);
    expect(dups).toHaveLength(0);
  });

  it('returns empty for no duplicates', () => {
    const rootFiles = [
      { fileName: 'AGENTS.md' as const, source: 'hub', domain: 'shared', absolutePath: '/a' },
    ];
    expect(detectRootFileDuplicates(rootFiles)).toHaveLength(0);
  });

  it('detects same root file from multiple sources', () => {
    const rootFiles = [
      { fileName: 'AGENTS.md' as const, source: 'hub', domain: 'shared', absolutePath: '/a' },
      { fileName: 'AGENTS.md' as const, source: 'extra', domain: 'shared', absolutePath: '/b' },
    ];
    const dups = detectRootFileDuplicates(rootFiles);
    expect(dups).toHaveLength(1);
    expect(dups[0].fileName).toBe('AGENTS.md');
  });

  it('returns empty for empty input', () => {
    expect(detectRootFileDuplicates([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM.md root file
// ---------------------------------------------------------------------------

describe('SYSTEM.md root file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manifest-system-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds SYSTEM.md in domain root', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['SYSTEM.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].fileName).toBe('SYSTEM.md');
    expect(rootFiles[0].domain).toBe('shared');
  });

  it('finds SYSTEM.md alongside AGENTS.md and CLAUDE.md', async () => {
    const config = makeConfig({ _localSourcePath: tmpDir });
    await buildSourceTree(tmpDir, {
      'shared': ['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md'],
    });

    const rootFiles = await scanRootFiles(tmpDir, config);
    expect(rootFiles).toHaveLength(3);
    const names = rootFiles.map((r) => r.fileName).sort();
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md']);
  });

  it('detects duplicate SYSTEM.md across domains', () => {
    const rootFiles = [
      { fileName: 'SYSTEM.md' as const, source: 'hub', domain: 'shared', absolutePath: '/a' },
      { fileName: 'SYSTEM.md' as const, source: 'hub', domain: 'backend', absolutePath: '/b' },
    ];
    const dups = detectRootFileDuplicates(rootFiles);
    expect(dups).toHaveLength(1);
    expect(dups[0].fileName).toBe('SYSTEM.md');
  });
});

// ---------------------------------------------------------------------------
// scanToolRootEntries (tool-prefixed flat files)
// ---------------------------------------------------------------------------

describe('scanToolRootEntries', () => {
  let tmpDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manifest-toolscan-'));
    sourceRoot = tmpDir;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('scans tool-prefixed flat files at domain level', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/my-skill': ['SKILL.md'],
    });
    await writeFile(join(sourceRoot, 'shared', 'cursor--settings.json'), '{}');

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('cursor');
    expect(entries[0].name).toBe('settings.json');
    expect(entries[0].source).toBe('hub');
    expect(entries[0].domain).toBe('shared');
  });

  it('ignores files for unconfigured tools', async () => {
    await mkdir(join(sourceRoot, 'shared'), { recursive: true });
    await writeFile(join(sourceRoot, 'shared', 'unknown--settings.json'), '{}');

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(0);
  });

  it('ignores files without a tool prefix', async () => {
    await mkdir(join(sourceRoot, 'shared'), { recursive: true });
    await writeFile(join(sourceRoot, 'shared', 'plain.json'), '{}');

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(0);
  });

  it('scans across multiple domains', async () => {
    await mkdir(join(sourceRoot, 'shared'), { recursive: true });
    await mkdir(join(sourceRoot, 'backend'), { recursive: true });
    await writeFile(join(sourceRoot, 'shared', 'cursor--settings.json'), '{}');
    await writeFile(join(sourceRoot, 'backend', 'cursor--rules.md'), '');

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(2);
    const domains = entries.map((e) => e.domain).sort();
    expect(domains).toEqual(['backend', 'shared']);
  });

  it('scans files for different tools', async () => {
    await mkdir(join(sourceRoot, 'shared'), { recursive: true });
    await writeFile(join(sourceRoot, 'shared', 'vscode--settings.json'), '{}');
    await writeFile(join(sourceRoot, 'shared', 'cursor--rules.md'), '');

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(2);
    const tools = entries.map((e) => e.toolName).sort();
    expect(tools).toEqual(['cursor', 'vscode']);
  });

  it('returns empty when no tool-prefixed files exist', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/skills/my-skill': ['SKILL.md'],
    });

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(0);
  });

  it('ignores directories with tool prefix', async () => {
    await buildSourceTree(sourceRoot, {
      'shared/cursor--rules/my-rule': ['rule.md'],
    });

    const config = makeConfig({ _localSourcePath: sourceRoot });
    const entries = await scanToolRootEntries(tmpDir, config);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectToolRootDuplicates
// ---------------------------------------------------------------------------

describe('detectToolRootDuplicates', () => {
  it('detects same name for same tool from different sources', () => {
    const entries = [
      {
        toolName: 'cursor',
        name: 'settings.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: '/a/shared/cursor--settings.json',
      },
      {
        toolName: 'cursor',
        name: 'settings.json',
        source: 'extra',
        domain: 'shared',
        absolutePath: '/b/shared/cursor--settings.json',
      },
    ];
    const dups = detectToolRootDuplicates(entries);
    expect(dups).toHaveLength(1);
    expect(dups[0].toolName).toBe('cursor');
    expect(dups[0].name).toBe('settings.json');
    expect(dups[0].paths).toEqual([
      '/a/shared/cursor--settings.json',
      '/b/shared/cursor--settings.json',
    ]);
  });

  it('allows same name for different tools', () => {
    const entries = [
      {
        toolName: 'cursor',
        name: 'settings.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: '/a/shared/cursor--settings.json',
      },
      {
        toolName: 'vscode',
        name: 'settings.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: '/a/shared/vscode--settings.json',
      },
    ];
    const dups = detectToolRootDuplicates(entries);
    expect(dups).toHaveLength(0);
  });

  it('returns empty for no duplicates', () => {
    const entries = [
      {
        toolName: 'cursor',
        name: 'settings.json',
        source: 'hub',
        domain: 'shared',
        absolutePath: '/a/shared/cursor--settings.json',
      },
    ];
    expect(detectToolRootDuplicates(entries)).toHaveLength(0);
  });

  it('returns empty for empty input', () => {
    expect(detectToolRootDuplicates([])).toHaveLength(0);
  });
});
