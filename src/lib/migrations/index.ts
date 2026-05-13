import { type BridgeConfig, saveConfig, loadConfig } from '../config.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A migration function receives the repo root and current config,
 * and returns the (possibly modified) config. It may also perform
 * filesystem operations (rename dirs, update files, etc.).
 */
export type MigrationFn = (
  repoRoot: string,
  config: BridgeConfig
) => Promise<BridgeConfig>;

export interface Migration {
  /** Semver version this migration upgrades TO (e.g. "0.6.0"). */
  version: string;
  /** Human-readable description shown when running. */
  description: string;
  /** The migration logic. */
  migrate: MigrationFn;
}

export interface MigrationResult {
  fromVersion: string;
  toVersion: string;
  applied: string[];
}

// ---------------------------------------------------------------------------
// Registry — add new migrations here in semver order
// ---------------------------------------------------------------------------

export const migrations: Migration[] = [
  // Example (uncomment when first real migration is needed):
  // {
  //   version: '0.6.0',
  //   description: 'rename domains key',
  //   migrate: async (_repoRoot, config) => {
  //     // transform config...
  //     return config;
  //   },
  // },
];

// ---------------------------------------------------------------------------
// Semver helpers (minimal — no external dep needed)
// ---------------------------------------------------------------------------

/** Parse "1.2.3" or "1.2.3-beta.1" into [major, minor, patch]. */
export function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^v/, '').split('-')[0];
  const parts = clean.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns -1 | 0 | 1 comparing a to b (ignores prerelease). */
export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Find migrations that should run when upgrading from `fromVersion` to
 * `toVersion`. Returns them sorted in ascending version order.
 */
export function pendingMigrations(
  fromVersion: string,
  toVersion: string
): Migration[] {
  return migrations
    .filter(
      (m) =>
        compareSemver(m.version, fromVersion) > 0 &&
        compareSemver(m.version, toVersion) <= 0
    )
    .sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * Run all pending migrations between the config's version and the
 * currently installed VERSION. Updates and saves the config afterwards.
 *
 * Returns null if no migration was needed.
 */
export async function runMigrations(
  repoRoot: string
): Promise<MigrationResult | null> {
  let config = await loadConfig(repoRoot);
  const configVersion = config.version ?? '0.0.0';

  const cmp = compareSemver(configVersion, VERSION);

  // Already current
  if (cmp === 0) return null;

  // Config is newer than installed package (downgrade)
  if (cmp > 0) return null;

  // Config is older — find and run migrations
  const pending = pendingMigrations(configVersion, VERSION);
  const applied: string[] = [];

  for (const migration of pending) {
    config = await migration.migrate(repoRoot, config);
    applied.push(migration.version);
  }

  // Always update the version, even if no migrations ran
  // (e.g. patch bump with no structural changes)
  config = { ...config, version: VERSION };
  await saveConfig(repoRoot, config);

  return {
    fromVersion: configVersion,
    toVersion: VERSION,
    applied,
  };
}
