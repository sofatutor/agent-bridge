#!/usr/bin/env node

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { updateCommand } from './commands/update.js';
import { optOutCommand } from './commands/opt-out.js';
import { VERSION } from './lib/version.js';

export interface CliOptions {
  cwd?: string;
  force?: boolean;
  // Init-specific options (ignored by other commands)
  domains?: string;
  tools?: string;
  source?: string[];
  hooks?: boolean;
}

async function assertCwdExists(cwd: string): Promise<void> {
  try {
    const s = await stat(cwd);
    if (!s.isDirectory()) {
      throw new Error(`--cwd path is not a directory: ${cwd}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`--cwd path does not exist: ${cwd}`);
    }
    throw err;
  }
}

async function withCwdValidation(
  action: (cwd?: string, opts?: CliOptions) => Promise<void>
): Promise<(opts: CliOptions) => Promise<void>> {
  return async (opts: CliOptions) => {
    if (opts.cwd) {
      opts.cwd = resolve(opts.cwd);
      await assertCwdExists(opts.cwd);
    }
    await action(opts.cwd, opts);
  };
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

const program = new Command()
  .name('agent-bridge')
  .description('Manage AI tool configurations from multiple sources')
  .version(VERSION, '-v, --version');

program
  .command('init')
  .description('Initialize Agent Bridge (creates .agent-bridge/config.yml)')
  .option('--cwd <path>', 'Override the working directory')
  .option('--force', 'Overwrite existing non-Agent-Bridge git hooks')
  .option('--domains <list>', 'Comma-separated domain list (default: backend,frontend,shared)')
  .option('--tools <list>', 'Comma-separated tool names (cursor,vscode,claude) or name:folder pairs')
  .option('-s, --source <url>', 'Source URL or path (repeatable, append #branch for branch)', collect, [])
  .option('--hooks', 'Auto-install git hooks without prompting')
  .action(await withCwdValidation(initCommand));

program
  .command('sync')
  .description('Fetch sources, discover features, and sync files')
  .option('--cwd <path>', 'Override the working directory')
  .action(await withCwdValidation(syncCommand));

program
  .command('update')
  .description('Fetch latest changes for all remote sources')
  .option('--cwd <path>', 'Override the working directory')
  .action(await withCwdValidation(updateCommand));

program
  .command('opt-out')
  .description('Remove Agent Bridge hooks, synced files, and .agent-bridge state')
  .option('--cwd <path>', 'Override the working directory')
  .action(await withCwdValidation(optOutCommand));

program.parse();
