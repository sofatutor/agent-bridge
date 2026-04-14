import * as p from '@clack/prompts';
import { loadConfig } from '../lib/config.js';
import { findRepoRoot } from '../lib/git.js';
import {
  discoverFeatureTypes,
  scanFeatures,
  detectDuplicates,
  featureMatchesTool,
  featureName,
} from '../lib/manifest.js';
import {
  featureDestPath,
  checkPathConflict,
  reconcileFeatures,
} from '../lib/symlinks.js';
import { syncAllSources, removeStaleSourceDirs } from '../lib/sources.js';
import { join } from 'node:path';

export async function syncCommand(cwd?: string): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

  p.intro('Agent Bridge Sync');

  const s = p.spinner();

  // --- Phase 1: Load & validate config ---
  s.start('Loading configuration…');

  const config = await loadConfig(repoRoot);

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

  s.stop(`${features.length} features found`);

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
  p.outro('Sync complete.');
}
