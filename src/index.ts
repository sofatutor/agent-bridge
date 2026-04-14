#!/usr/bin/env node

import { resolve } from 'node:path';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { updateCommand } from './commands/update.js';

const COMMANDS: Record<string, (cwd?: string) => Promise<void>> = {
  init: initCommand,
  sync: syncCommand,
  update: updateCommand,
};

const HELP_TEXT = `
agent-bridge — Manage AI tool configurations from multiple sources

Usage: agent-bridge <command> [options]

Commands:
  init     Initialize Agent Bridge (creates .agent-bridge/config.yml)
  sync     Fetch sources, discover features, and sync files
  update   Fetch latest changes for all remote sources

Options:
  --cwd <path>  Override the working directory (defaults to git root or cwd)
`;

function parseCwd(): string | undefined {
  const idx = process.argv.indexOf('--cwd');
  if (idx !== -1 && process.argv[idx + 1]) {
    return resolve(process.argv[idx + 1]);
  }
  return undefined;
}

const command = process.argv.filter((a) => !a.startsWith('--') && process.argv.indexOf(a) > 1)[0];
const cwd = parseCwd();

if (!command || command === 'help') {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (COMMANDS[command]) {
  COMMANDS[command](cwd).catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  console.log(HELP_TEXT);
  process.exit(1);
}
