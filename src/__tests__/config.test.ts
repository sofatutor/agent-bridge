import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSourceType,
  isRemoteSource,
  bridgeDir,
  configPath,
  sourceDir,
  configExists,
  loadConfig,
  saveConfig,
  validateConfig,
  BRIDGE_DIR,
  CONFIG_FILENAME,
  sourceDomains,
  isIncluded,
  type BridgeConfig,
} from '../lib/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    domains: ['backend', 'frontend', 'shared'],
    tools: [
      { name: 'vscode', folder: '.github' },
      { name: 'cursor', folder: '.cursor' },
    ],
    sources: [
      {
        name: 'hub',
        source: 'https://github.com/sofatutor/agent-hub.git',
        branch: 'main',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectSourceType
// ---------------------------------------------------------------------------

describe('detectSourceType', () => {
  it('detects HTTPS URLs', () => {
    expect(detectSourceType('https://github.com/org/repo.git')).toBe(
      'git-https'
    );
  });

  it('detects HTTP URLs', () => {
    expect(detectSourceType('http://github.com/org/repo.git')).toBe(
      'git-https'
    );
  });

  it('detects SSH URLs', () => {
    expect(detectSourceType('git@github.com:org/repo.git')).toBe('git-ssh');
  });

  it('detects SSH with custom user', () => {
    expect(detectSourceType('deploy@gitlab.com:org/repo.git')).toBe('git-ssh');
  });

  it('detects local paths (relative)', () => {
    expect(detectSourceType('./path/to/repo')).toBe('local');
  });

  it('detects local paths (absolute)', () => {
    expect(detectSourceType('/absolute/path/to/repo')).toBe('local');
  });

  it('detects local paths (home dir)', () => {
    expect(detectSourceType('~/my-repo')).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// isRemoteSource
// ---------------------------------------------------------------------------

describe('isRemoteSource', () => {
  it('returns true for HTTPS', () => {
    expect(isRemoteSource('https://github.com/org/repo.git')).toBe(true);
  });

  it('returns true for SSH', () => {
    expect(isRemoteSource('git@github.com:org/repo.git')).toBe(true);
  });

  it('returns false for local paths', () => {
    expect(isRemoteSource('./local/path')).toBe(false);
    expect(isRemoteSource('/absolute/path')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
  it('bridgeDir returns .agent-bridge path', () => {
    expect(bridgeDir('/repo')).toBe(join('/repo', BRIDGE_DIR));
  });

  it('configPath returns .agent-bridge/config.yml', () => {
    expect(configPath('/repo')).toBe(
      join('/repo', BRIDGE_DIR, CONFIG_FILENAME)
    );
  });

  it('sourceDir returns .agent-bridge/<name>', () => {
    expect(sourceDir('/repo', 'my-source')).toBe(
      join('/repo', BRIDGE_DIR, 'my-source')
    );
  });
});

// ---------------------------------------------------------------------------
// Config I/O (filesystem)
// ---------------------------------------------------------------------------

describe('config I/O', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('configExists returns false when no config', async () => {
    expect(await configExists(tmpDir)).toBe(false);
  });

  it('saveConfig creates .agent-bridge/ directory and writes YAML', async () => {
    const cfg = validConfig();
    await saveConfig(tmpDir, cfg);

    expect(await configExists(tmpDir)).toBe(true);

    const raw = await readFile(configPath(tmpDir), 'utf-8');
    expect(raw).toContain('domains:');
    expect(raw).toContain('tools:');
    expect(raw).toContain('sources:');
  });

  it('loadConfig reads back what was saved', async () => {
    const cfg = validConfig();
    await saveConfig(tmpDir, cfg);
    const loaded = await loadConfig(tmpDir);

    expect(loaded.domains).toEqual(cfg.domains);
    expect(loaded.tools).toEqual(cfg.tools);
    expect(loaded.sources).toEqual(cfg.sources);
  });

  it('loadConfig throws on invalid YAML', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(bridgeDir(tmpDir), { recursive: true });
    await writeFile(configPath(tmpDir), '--- []', 'utf-8');

    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid config');
  });

  it('loadConfig throws when config shape is invalid', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(bridgeDir(tmpDir), { recursive: true });
    await writeFile(
      configPath(tmpDir),
      ['domains: [shared]', 'tools: invalid', 'sources: []'].join('\n'),
      'utf-8'
    );

    await expect(loadConfig(tmpDir)).rejects.toThrow('Invalid config:');
  });

  it('saveConfig is idempotent (overwrites cleanly)', async () => {
    const cfg1 = validConfig({ domains: ['a'] });
    await saveConfig(tmpDir, cfg1);

    const cfg2 = validConfig({ domains: ['x', 'y'] });
    await saveConfig(tmpDir, cfg2);

    const loaded = await loadConfig(tmpDir);
    expect(loaded.domains).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('fails when config is not an object', () => {
    const result = validateConfig([]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('expected object');
  });

  it('passes for a valid config', () => {
    const result = validateConfig(validConfig());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when a tool entry is not an object', () => {
    const result = validateConfig({
      ...validConfig(),
      tools: ['vscode'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('tools') && e.includes('object'))).toBe(true);
  });

  it('fails when a source entry is not an object', () => {
    const result = validateConfig({
      ...validConfig(),
      sources: ['hub'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('sources') && e.includes('object'))).toBe(true);
  });

  // --- domains ---

  it('fails when domains is missing', () => {
    const cfg = validConfig({ domains: [] });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('domains');
  });

  it('fails when domains contains empty string', () => {
    const cfg = validConfig({ domains: ['backend', ''] });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('domain');
  });

  // --- tools ---

  it('fails when tools is empty', () => {
    const cfg = validConfig({ tools: [] });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tools'))).toBe(true);
  });

  it('fails when tool has no name', () => {
    const cfg = validConfig({
      tools: [{ name: '', folder: '.github' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('fails when tool has no folder', () => {
    const cfg = validConfig({
      tools: [{ name: 'vscode', folder: '' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('folder'))).toBe(true);
  });

  it('fails on duplicate tool names', () => {
    const cfg = validConfig({
      tools: [
        { name: 'vscode', folder: '.github' },
        { name: 'vscode', folder: '.vscode' },
      ],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate tool'))).toBe(true);
  });

  // --- sources ---

  it('fails when sources is empty', () => {
    const cfg = validConfig({ sources: [] });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('sources'))).toBe(true);
  });

  it('fails when source has no name', () => {
    const cfg = validConfig({
      sources: [{ name: '', source: 'https://example.com/repo.git' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
  });

  it('fails when source has no source URL', () => {
    const cfg = validConfig({
      sources: [{ name: 'hub', source: '' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
  });

  it('fails on duplicate source names', () => {
    const cfg = validConfig({
      sources: [
        { name: 'hub', source: 'https://github.com/org/a.git' },
        { name: 'hub', source: 'https://github.com/org/b.git' },
      ],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate source'))).toBe(
      true
    );
  });

  it('fails when branch is set on a local source', () => {
    const cfg = validConfig({
      sources: [{ name: 'local', source: '/absolute/path', branch: 'main' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('branch'))).toBe(true);
  });

  it('fails when local source uses a relative path', () => {
    const cfg = validConfig({
      sources: [{ name: 'local', source: './relative/path' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('absolute'))).toBe(true);
  });

  it('allows absolute paths for local sources', () => {
    const cfg = validConfig({
      sources: [{ name: 'local', source: '/absolute/path/to/source' }],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(true);
  });

  it('allows branch on remote sources', () => {
    const cfg = validConfig({
      sources: [
        {
          name: 'hub',
          source: 'https://github.com/org/repo.git',
          branch: 'v2',
        },
      ],
    });
    const result = validateConfig(cfg);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-source domains & include lists (0.14+)
// ---------------------------------------------------------------------------

describe('per-source domains', () => {
  it('accepts bare-string domains and normalizes them to objects', () => {
    const cfg = {
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: '/abs/hub', domains: ['shared', { name: 'backend', include: ['skills'] }] }],
    };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('fails when a source has no domains and there is no top-level fallback', () => {
    const cfg = {
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: '/abs/hub' }],
    };
    const result = validateConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('no domains');
  });

  it('accepts legacy configs: top-level domains, none per source', () => {
    expect(validateConfig(validConfig()).ok).toBe(true);
  });

  it('rejects include paths deeper than two segments or with unsafe characters', () => {
    const bad = (include: string[]) =>
      validateConfig({
        tools: [{ name: 'vscode', folder: '.github' }],
        sources: [{ name: 'hub', source: '/abs/hub', domains: [{ name: 'shared', include }] }],
      });
    expect(bad(['skills/a/b']).ok).toBe(false);
    expect(bad(['../etc']).ok).toBe(false);
    expect(bad(['skills/deploy', 'AGENTS.md', 'cursor--settings.json']).ok).toBe(true);
  });

  it('rejects duplicate domains inside one source', () => {
    const result = validateConfig({
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'hub', source: '/abs/hub', domains: ['shared', 'shared'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Duplicate domain');
  });
});

describe('sourceDomains', () => {
  it('prefers the source\'s own domains', () => {
    const cfg = validConfig({
      sources: [{ name: 'hub', source: '/abs/hub', domains: [{ name: 'x' }] }],
    });
    expect(sourceDomains(cfg, cfg.sources[0])).toEqual([{ name: 'x' }]);
  });

  it('falls back to legacy top-level domains', () => {
    const cfg = validConfig({ domains: ['a', 'b'] });
    expect(sourceDomains(cfg, cfg.sources[0])).toEqual([{ name: 'a' }, { name: 'b' }]);
  });
});

describe('isIncluded', () => {
  it('includes everything when no include list', () => {
    expect(isIncluded({ name: 'd' }, 'skills/anything')).toBe(true);
  });

  it('matches a whole feature type and its children', () => {
    const d = { name: 'd', include: ['skills'] };
    expect(isIncluded(d, 'skills')).toBe(true);
    expect(isIncluded(d, 'skills/deploy')).toBe(true);
    expect(isIncluded(d, 'agents')).toBe(false);
    expect(isIncluded(d, 'AGENTS.md')).toBe(false);
  });

  it('matches a single feature and keeps its parent type visible', () => {
    const d = { name: 'd', include: ['skills/deploy'] };
    expect(isIncluded(d, 'skills')).toBe(true);
    expect(isIncluded(d, 'skills/deploy')).toBe(true);
    expect(isIncluded(d, 'skills/other')).toBe(false);
  });

  it('matches flat files exactly', () => {
    const d = { name: 'd', include: ['AGENTS.md'] };
    expect(isIncluded(d, 'AGENTS.md')).toBe(true);
    expect(isIncluded(d, 'CLAUDE.md')).toBe(false);
  });
});

describe('saveConfig compact domains', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'agent-bridge-compact-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes domains without include as bare strings and round-trips', async () => {
    const cfg: BridgeConfig = {
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [
        { name: 'hub', source: '/abs/hub', domains: [{ name: 'shared' }, { name: 'backend', include: ['skills/deploy'] }] },
      ],
    };
    await saveConfig(tmp, cfg);
    const raw = await readFile(configPath(tmp), 'utf-8');
    expect(raw).toContain('- shared\n');
    expect(raw).toContain('name: backend');
    expect(raw).not.toContain('domains: null');
    const loaded = await loadConfig(tmp);
    expect(loaded.sources[0].domains).toEqual(cfg.sources[0].domains);
  });
});
