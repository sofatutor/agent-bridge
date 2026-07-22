import * as p from '@clack/prompts';
import {
  bridgeDir,
  configExists,
  loadConfig,
  writeOptOutMarker,
  OPT_OUT_MARKER,
  type BridgeConfig,
} from '../lib/config.js';
import { removeDir, dirExists } from '../lib/fs.js';
import { findRepoRoot, isInGitRepo, removeGitHooks } from '../lib/git.js';
import { reconcileFeatures, reconcileToolRootEntries } from '../lib/sync.js';

function summarizeTools(config: BridgeConfig): string {
  return config.tools.map((t) => t.name).join(', ');
}

export async function optOutCommand(
  cwd?: string,
  _opts?: unknown
): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

  p.intro('Agent Bridge Opt-out');

  const hasConfig = await configExists(repoRoot);
  let config: BridgeConfig | undefined;

  if (hasConfig) {
    config = await loadConfig(repoRoot);
  }

  const toolSummary = config ? summarizeTools(config) : 'unknown (no config found)';
  p.log.info(
    `Non-interactive opt-out: removing Agent Bridge managed files for tools: ${toolSummary}`
  );

  const s = p.spinner();

  let featureErrors = 0;
  let toolRootErrors = 0;

  if (config) {
    s.start('Removing synced Agent Bridge files…');

    const featureResult = await reconcileFeatures(repoRoot, config, []);
    const toolRootResult = await reconcileToolRootEntries(repoRoot, config, []);

    featureErrors = featureResult.errors.length;
    toolRootErrors = toolRootResult.errors.length;

    s.stop('Synced files removed');

    p.log.info(
      `Features removed: ${featureResult.removed} (errors: ${featureErrors})`
    );
    p.log.info(
      `Tool-root files removed: ${toolRootResult.removed} (errors: ${toolRootErrors})`
    );
    p.log.info('Root files are not removed by opt-out (manifest-only cleanup).');

    for (const err of featureResult.errors) {
      p.log.error(`${err.path}: ${err.error}`);
    }
    for (const err of toolRootResult.errors) {
      p.log.error(`${err.path}: ${err.error}`);
    }
  } else {
    p.log.warn('No .agent-bridge/config.yml found. Skipping synced file cleanup.');
  }

  s.start('Removing Agent Bridge git hooks…');
  const removedHooks = isInGitRepo(repoRoot) ? await removeGitHooks(repoRoot) : [];
  s.stop('Hooks cleanup complete');

  if (removedHooks.length > 0) {
    p.log.info(`Removed hooks: ${removedHooks.join(', ')}`);
  } else if (isInGitRepo(repoRoot)) {
    p.log.info('No Agent Bridge hooks found.');
  } else {
    p.log.info('Not a git repository; hook cleanup skipped.');
  }

  s.start('Removing .agent-bridge directory…');
  const bridgePath = bridgeDir(repoRoot);
  if (await dirExists(bridgePath)) {
    await removeDir(bridgePath);
    s.stop('.agent-bridge removed');
  } else {
    s.stop('.agent-bridge not found');
  }

  // Write a tombstone that survives `.agent-bridge/` deletion so a postinstall
  // guard (or a manual init/sync) won't silently reinstall on the next install.
  await writeOptOutMarker(repoRoot);
  p.log.info(
    `Wrote ${OPT_OUT_MARKER}. Commit it for a repo-wide opt-out, or gitignore it to keep opt-out local. ` +
      'Run `agent-bridge init --force` to re-enable.'
  );

  const totalErrors = featureErrors + toolRootErrors;
  if (totalErrors > 0) {
    p.outro(`Opt-out completed with ${totalErrors} cleanup error(s).`);
    process.exit(1);
  }

  p.outro('Opt-out complete. Agent Bridge is removed from this repository.');
}
