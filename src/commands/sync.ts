import * as p from '@clack/prompts';
import { loadConfig, isOptedOut, OPT_OUT_MARKER } from '../lib/config.js';
import { findRepoRoot } from '../lib/git.js';
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

export async function syncCommand(cwd?: string, _opts?: unknown): Promise<void> {
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

  const config = await loadConfig(repoRoot);

  // Run pending migrations if config version is outdated
  const migrationResult = await runMigrations(repoRoot);
  if (migrationResult) {
    p.log.info(
      `Config upgraded ${migrationResult.fromVersion} → ${migrationResult.toVersion}` +
        (migrationResult.applied.length > 0
          ? ` (${migrationResult.applied.length} migration(s))`
          : '')
    );
  }

  s.stop('Configuration valid');

  // --- Phase 2: Sync sources ---
  s.start('Syncing sources…');

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

  s.stop('Sources synced');

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

  p.outro('Sync complete.');
}
