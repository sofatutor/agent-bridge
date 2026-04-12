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
// symlinkName
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

  it('skips non-directory entries', async () => {
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
    expect(features).toHaveLength(1);
    expect(features[0].name).toBe('foundation');
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
