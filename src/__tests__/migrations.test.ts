import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveConfig,
  loadConfig,
  type BridgeConfig,
} from '../lib/config.js';
import {
  parseSemver,
  compareSemver,
  pendingMigrations,
  runMigrations,
  migrations,
  type Migration,
} from '../lib/migrations/index.js';
import { VERSION } from '../lib/version.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(version?: string): BridgeConfig {
  return {
    version,
    domains: ['shared'],
    tools: [{ name: 'vscode', folder: '.github' }],
    sources: [{ name: 'test-source', source: '/tmp/test-source' }],
  };
}

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe('parseSemver', () => {
  it('parses a simple version', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
  });

  it('strips leading v', () => {
    expect(parseSemver('v0.5.0')).toEqual([0, 5, 0]);
  });

  it('ignores prerelease suffix', () => {
    expect(parseSemver('0.5.0-beta.1')).toEqual([0, 5, 0]);
  });

  it('handles dev suffix', () => {
    expect(parseSemver('0.4.2-dev.abc1234')).toEqual([0, 4, 2]);
  });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareSemver('0.4.2', '0.5.0')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
  });

  it('compares major first', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('compares minor second', () => {
    expect(compareSemver('0.5.0', '0.4.99')).toBe(1);
  });

  it('compares patch last', () => {
    expect(compareSemver('0.5.1', '0.5.0')).toBe(1);
  });

  it('ignores prerelease when cores match', () => {
    expect(compareSemver('0.5.0-beta.1', '0.5.0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pendingMigrations
// ---------------------------------------------------------------------------

describe('pendingMigrations', () => {
  const fakeMigrations: Migration[] = [
    { version: '0.5.0', description: 'migration A', migrate: async (_r, c) => c },
    { version: '0.6.0', description: 'migration B', migrate: async (_r, c) => c },
    { version: '0.7.0', description: 'migration C', migrate: async (_r, c) => c },
    { version: '1.0.0', description: 'migration D', migrate: async (_r, c) => c },
  ];

  // Temporarily replace the global registry for these tests
  let originalMigrations: Migration[];

  beforeEach(() => {
    originalMigrations = migrations.splice(0, migrations.length, ...fakeMigrations);
  });

  afterEach(() => {
    migrations.splice(0, migrations.length, ...originalMigrations);
  });

  it('returns migrations between fromVersion and toVersion', () => {
    const pending = pendingMigrations('0.5.0', '0.7.0');
    expect(pending.map((m) => m.version)).toEqual(['0.6.0', '0.7.0']);
  });

  it('excludes the fromVersion migration', () => {
    const pending = pendingMigrations('0.5.0', '1.0.0');
    expect(pending.map((m) => m.version)).toEqual(['0.6.0', '0.7.0', '1.0.0']);
  });

  it('returns empty when already current', () => {
    expect(pendingMigrations('1.0.0', '1.0.0')).toEqual([]);
  });

  it('returns empty when no migrations in range', () => {
    expect(pendingMigrations('0.7.0', '0.9.0')).toEqual([]);
  });

  it('includes the toVersion migration', () => {
    const pending = pendingMigrations('0.4.0', '0.5.0');
    expect(pending.map((m) => m.version)).toEqual(['0.5.0']);
  });

  it('returns all when upgrading from 0.0.0', () => {
    const pending = pendingMigrations('0.0.0', '1.0.0');
    expect(pending).toHaveLength(4);
  });

  it('returns results sorted by version', () => {
    // Push out-of-order migration
    migrations.push({
      version: '0.5.5',
      description: 'out of order',
      migrate: async (_r, c) => c,
    });

    const pending = pendingMigrations('0.5.0', '0.6.0');
    expect(pending.map((m) => m.version)).toEqual(['0.5.5', '0.6.0']);

    // Clean up
    migrations.pop();
  });
});

// ---------------------------------------------------------------------------
// runMigrations (integration with filesystem)
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  let tmpDir: string;
  let repoRoot: string;
  let originalMigrations: Migration[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-bridge-migration-'));
    repoRoot = tmpDir;

    // Save original migrations and clear
    originalMigrations = migrations.splice(0, migrations.length);
  });

  afterEach(async () => {
    // Restore original migrations
    migrations.splice(0, migrations.length, ...originalMigrations);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when config version matches installed version', async () => {
    await saveConfig(repoRoot, makeConfig(VERSION));
    const result = await runMigrations(repoRoot);
    expect(result).toBeNull();
  });

  it('updates config version when outdated (no migrations)', async () => {
    await saveConfig(repoRoot, makeConfig('0.1.0'));
    const result = await runMigrations(repoRoot);

    expect(result).not.toBeNull();
    expect(result!.fromVersion).toBe('0.1.0');
    expect(result!.toVersion).toBe(VERSION);
    expect(result!.applied).toEqual([]);

    // Config on disk should be updated
    const loaded = await loadConfig(repoRoot);
    expect(loaded.version).toBe(VERSION);
  });

  it('treats missing version as 0.0.0', async () => {
    await saveConfig(repoRoot, makeConfig(undefined));
    const result = await runMigrations(repoRoot);

    expect(result).not.toBeNull();
    expect(result!.fromVersion).toBe('0.0.0');
  });

  it('returns null when config is newer (downgrade)', async () => {
    await saveConfig(repoRoot, makeConfig('99.0.0'));
    const result = await runMigrations(repoRoot);
    expect(result).toBeNull();
  });

  it('runs pending migrations in order', async () => {
    const order: string[] = [];

    migrations.push(
      {
        version: '0.2.0',
        description: 'first',
        migrate: async (_r, config) => {
          order.push('0.2.0');
          return config;
        },
      },
      {
        version: '0.3.0',
        description: 'second',
        migrate: async (_r, config) => {
          order.push('0.3.0');
          return config;
        },
      }
    );

    await saveConfig(repoRoot, makeConfig('0.1.0'));
    const result = await runMigrations(repoRoot);

    expect(result).not.toBeNull();
    expect(result!.applied).toEqual(['0.2.0', '0.3.0']);
    expect(order).toEqual(['0.2.0', '0.3.0']);
  });

  it('migrations can modify config', async () => {
    migrations.push({
      version: '0.2.0',
      description: 'add domain',
      migrate: async (_r, config) => ({
        ...config,
        domains: [...config.domains, 'backend'],
      }),
    });

    await saveConfig(repoRoot, makeConfig('0.1.0'));
    await runMigrations(repoRoot);

    const loaded = await loadConfig(repoRoot);
    expect(loaded.domains).toEqual(['shared', 'backend']);
    expect(loaded.version).toBe(VERSION);
  });

  it('only runs migrations in the target range', async () => {
    const ran: string[] = [];

    // This migration is before the config version — should NOT run
    migrations.push({
      version: '0.1.0',
      description: 'should not run',
      migrate: async (_r, config) => {
        ran.push('0.1.0');
        return config;
      },
    });

    // This one is after — should run
    migrations.push({
      version: '0.3.0',
      description: 'should run',
      migrate: async (_r, config) => {
        ran.push('0.3.0');
        return config;
      },
    });

    await saveConfig(repoRoot, makeConfig('0.2.0'));
    await runMigrations(repoRoot);

    expect(ran).toEqual(['0.3.0']);
  });
});
