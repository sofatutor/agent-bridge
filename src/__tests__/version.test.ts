import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { VERSION } from '../lib/version.js';
import { saveConfig, loadConfig, type BridgeConfig } from '../lib/config.js';

// ---------------------------------------------------------------------------
// VERSION constant
// ---------------------------------------------------------------------------

describe('VERSION', () => {
  it('exports a version string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('is a valid semver-like string', () => {
    // Should match patterns like "0.1.0", "1.2.3", "0.0.1-dev"
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Version in config
// ---------------------------------------------------------------------------

describe('version in config', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'agent-bridge-version-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves version in config file', async () => {
    const config: BridgeConfig = {
      version: VERSION,
      domains: ['backend'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'test', source: '/path/to/source' }],
    };

    await saveConfig(testDir, config);
    const loaded = await loadConfig(testDir);

    expect(loaded.version).toBe(VERSION);
  });

  it('persists version to YAML file', async () => {
    const config: BridgeConfig = {
      version: '1.2.3',
      domains: ['backend'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'test', source: '/path/to/source' }],
    };

    await saveConfig(testDir, config);

    const raw = await readFile(join(testDir, '.agent-bridge', 'config.yml'), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    expect(parsed.version).toBe('1.2.3');
  });

  it('loads config without version (backwards compat)', async () => {
    const config: BridgeConfig = {
      domains: ['backend'],
      tools: [{ name: 'vscode', folder: '.github' }],
      sources: [{ name: 'test', source: '/path/to/source' }],
    };

    await saveConfig(testDir, config);
    const loaded = await loadConfig(testDir);

    // version should be undefined for old configs
    expect(loaded.version).toBeUndefined();
  });
});
