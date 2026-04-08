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

    await expect(loadConfig(tmpDir)).rejects.toThrow(
      "Invalid config: 'tools' must be a non-empty array"
    );
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
    expect(result.errors[0]).toContain('YAML object');
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
    expect(result.errors).toContain('Each tool must be an object');
  });

  it('fails when a source entry is not an object', () => {
    const result = validateConfig({
      ...validConfig(),
      sources: ['hub'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Each source must be an object');
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
