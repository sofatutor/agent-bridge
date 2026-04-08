import * as p from '@clack/prompts';
import { loadConfig } from '../lib/config.js';
import { findRepoRoot } from '../lib/git.js';
import { syncAllSources } from '../lib/sources.js';

export async function updateCommand(cwd?: string): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

  p.intro('Agent Bridge — Update Sources');

  const config = await loadConfig(repoRoot);

  const s = p.spinner();
  s.start('Updating all remote sources…');

  const results = await syncAllSources(repoRoot, config);

  s.stop('Update complete');

  for (const r of results) {
    if (r.error) {
      p.log.error(`${r.name}: ${r.error}`);
    } else {
      p.log.info(`${r.name}: ${r.action}`);
    }
  }

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    p.outro(`Done with ${errors.length} error(s).`);
  } else {
    p.outro('All sources up to date.');
  }
}
