import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { loadConfig, isOptedOut, OPT_OUT_MARKER, type BridgeConfig } from '../lib/config.js';
import { findRepoRoot, isInGitRepo, installGitHooks } from '../lib/git.js';
import { runMigrations } from '../lib/migrations/index.js';
import {
  discoverFeatureTypes,
  scanFeatures,
  detectDuplicates,
  scanRootFiles,
  detectRootFileDuplicates,
  scanToolRootEntries,
  detectToolRootDuplicates,
  featureMatchesTool,
  featureName,
} from '../lib/manifest.js';
import {
  featureDestPath,
  checkPathConflict,
  reconcileFeatures,
  syncRootFiles,
  reconcileToolRootEntries,
} from '../lib/sync.js';
import { syncAllSources, removeStaleSourceDirs } from '../lib/sources.js';
import { join } from 'node:path';

export interface SyncOptions {
  /** Install/refresh git hooks after a successful sync. */
  hooks?: boolean;
  /** With `hooks`: overwrite foreign hooks. */
  force?: boolean;
  /** `name=path` overrides: read that source from `path` instead of cloning. */
  source?: string[];
}

/**
 * Apply `--source name=path` overrides. Lets CI point a committed remote
 * source at a checkout it already has (no SSH key needed) while keeping the
 * committed domain/include selection. Not persisted.
 */
export function applySourceOverrides(config: BridgeConfig, overrides: string[], repoRoot: string): BridgeConfig {
  if (overrides.length === 0) return config;
  const sources = config.sources.map((s) => ({ ...s }));
  for (const raw of overrides) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error(`--source expects name=path, got "${raw}"`);
    const name = raw.slice(0, eq).trim();
    const path = raw.slice(eq + 1).trim();
    const src = sources.find((s) => s.name === name);
    if (!src) throw new Error(`--source: no source named "${name}" in config.yml`);
    src.source = resolve(repoRoot, path);
    delete src.branch;
  }
  return { ...config, sources };
}

export async function syncCommand(cwd?: string, opts?: SyncOptions): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

  p.intro('Agent Bridge Sync');

  // Respect an opt-out tombstone so a postinstall guard doesn't re-sync.
  if (await isOptedOut(repoRoot)) {
    p.log.warn(`${OPT_OUT_MARKER} present — Agent Bridge is opted out. Skipping sync.`);
    p.outro('Skipped (opted out).');
    return;
  }

  const s = p.spinner();

  // --- Phase 1: Load & validate config ---
  s.start('Loading configuration…');

  // Run pending migrations first so we work with the upgraded config
  const migrationResult = await runMigrations(repoRoot);
  if (migrationResult) {
    p.log.info(
      `Config upgraded ${migrationResult.fromVersion} → ${migrationResult.toVersion}` +
        (migrationResult.applied.length > 0
          ? ` (${migrationResult.applied.length} migration(s))`
          : '')
    );
  }

  const config = applySourceOverrides(await loadConfig(repoRoot), opts?.source ?? [], repoRoot);
  s.stop('Configuration valid');

  // --- Phase 2: Fetch sources (clone new, pull existing) ---
  s.start('Fetching sources…');

  const sourceResults = await syncAllSources(repoRoot, config);
  const sourceErrors = sourceResults.filter((r) => r.error);
  if (sourceErrors.length > 0) {
    s.stop('Some sources failed');
    for (const err of sourceErrors) {
      p.log.error(`${err.name}: ${err.error}`);
    }
    process.exit(1);
  }

  // Clean up stale source directories
  const staleRemoved = await removeStaleSourceDirs(repoRoot, config);
  if (staleRemoved.length > 0) {
    for (const name of staleRemoved) {
      p.log.info(`Removed stale source: ${name}`);
    }
  }

  for (const r of sourceResults) {
    if (r.action !== 'local') {
      p.log.info(`${r.name}: ${r.action}`);
    }
  }

  s.stop('Sources up to date');

  // --- Phase 3: Discover & validate features ---
  s.start('Discovering features…');

  const featureTypes = await discoverFeatureTypes(repoRoot, config);
  const features = await scanFeatures(repoRoot, config, featureTypes);
  const rootFiles = await scanRootFiles(repoRoot, config);
  const toolRootEntries = await scanToolRootEntries(repoRoot, config);

  const duplicates = detectDuplicates(features);
  if (duplicates.length > 0) {
    s.stop('Duplicate features detected');
    for (const dup of duplicates) {
      p.log.error(
        `Duplicate "${dup.name}" (${dup.type}): ${dup.paths.join(', ')}`
      );
    }
    process.exit(1);
  }

  const rootDuplicates = detectRootFileDuplicates(rootFiles);
  if (rootDuplicates.length > 0) {
    s.stop('Duplicate root files detected');
    for (const dup of rootDuplicates) {
      p.log.error(
        `Duplicate "${dup.fileName}": ${dup.paths.join(', ')}`
      );
    }
    process.exit(1);
  }

  const toolRootDuplicates = detectToolRootDuplicates(toolRootEntries);
  if (toolRootDuplicates.length > 0) {
    s.stop('Duplicate tool root entries detected');
    for (const dup of toolRootDuplicates) {
      p.log.error(
        `Duplicate "${dup.name}" for tool "${dup.toolName}": ${dup.paths.join(', ')}`
      );
    }
    process.exit(1);
  }

  s.stop(`${features.length} features found${rootFiles.length > 0 ? `, ${rootFiles.length} root file(s)` : ''}${toolRootEntries.length > 0 ? `, ${toolRootEntries.length} tool root entr${toolRootEntries.length === 1 ? 'y' : 'ies'}` : ''}`);

  // --- Phase 3b: Detect path conflicts ---
  s.start('Checking for path conflicts…');

  const conflicts: string[] = [];
  for (const tool of config.tools) {
    for (const feature of features) {
      if (!featureMatchesTool(feature, tool.name)) continue;

      const linkName = featureName(feature);
      const featureTypeDir = join(repoRoot, tool.folder, feature.displayType);
      const dest = featureDestPath(
        repoRoot,
        tool.folder,
        feature.displayType,
        linkName
      );
      if (await checkPathConflict(featureTypeDir, linkName, feature.isFile)) {
        conflicts.push(dest);
      }
    }
  }

  if (conflicts.length > 0) {
    s.stop('Path conflicts detected');
    for (const c of conflicts) {
      p.log.error(`Conflict: "${c}" exists as a real file or directory`);
    }
    p.log.info('Remove or rename the conflicting paths, then re-run sync.');
    process.exit(1);
  }

  s.stop('No path conflicts');

  // --- Phase 4: Reconcile features ---
  s.start('Reconciling features…');

  const result = await reconcileFeatures(repoRoot, config, features);

  s.stop('Features reconciled');

  p.log.info(
    `Added: ${result.added}  Updated: ${result.updated}  Removed: ${result.removed}`
  );

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      p.log.error(`${err.path}: ${err.error}`);
    }
    p.outro(`Sync completed with ${result.errors.length} error(s).`);
    process.exit(1);
  }

  // --- Phase 5: Sync root files ---
  if (rootFiles.length > 0) {
    s.start('Syncing root files…');

    const rootResult = await syncRootFiles(repoRoot, rootFiles);

    for (const name of rootResult.synced) {
      p.log.info(`Root file synced: ${name}`);
    }
    for (const name of rootResult.removed) {
      p.log.info(`Root file removed: ${name}`);
    }
    for (const err of rootResult.errors) {
      p.log.error(`${err.path}: ${err.error}`);
    }

    s.stop('Root files synced');
  } else {
    // Clean up any managed root files when no sources provide them
    const rootResult = await syncRootFiles(repoRoot, []);
    for (const name of rootResult.removed) {
      p.log.info(`Root file removed: ${name}`);
    }
  }

  // --- Phase 6: Sync tool root entries ---
  s.start('Syncing tool root entries…');

  const toolRootResult = await reconcileToolRootEntries(
    repoRoot,
    config,
    toolRootEntries
  );

  if (
    toolRootResult.added > 0 ||
    toolRootResult.updated > 0 ||
    toolRootResult.removed > 0
  ) {
    p.log.info(
      `Tool root: Added: ${toolRootResult.added}  Updated: ${toolRootResult.updated}  Removed: ${toolRootResult.removed}`
    );
  }

  if (toolRootResult.errors.length > 0) {
    for (const err of toolRootResult.errors) {
      p.log.error(`${err.path}: ${err.error}`);
    }
    s.stop('Tool root entries synced with errors');
    p.outro(`Sync completed with ${toolRootResult.errors.length} error(s).`);
    process.exit(1);
  }

  s.stop('Tool root entries synced');

  // --- Phase 7: Git hooks (opt-in; idempotent so postinstall can call it) ---
  if (opts?.hooks && isInGitRepo(repoRoot)) {
    const hooks = await installGitHooks(repoRoot, opts.force === true);
    if (hooks.installed.length > 0) p.log.info(`Git hooks installed: ${hooks.installed.join(', ')}`);
    if (hooks.skipped.length > 0) p.log.warn(`Hooks skipped (existing non-Agent-Bridge hooks): ${hooks.skipped.join(', ')}`);
    for (const e of hooks.errors) p.log.error(`Hook ${e.hook}: ${e.error}`);
  }

  p.outro('Sync complete.');
}
