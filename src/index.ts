#!/usr/bin/env node

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { updateCommand } from './commands/update.js';
import { VERSION } from './lib/version.js';

export interface CliOptions {
  cwd?: string;
  force?: boolean;
}

type CommandFn = (cwd?: string, opts?: CliOptions) => Promise<void>;

const COMMANDS: Record<string, CommandFn> = {
  init: initCommand as CommandFn,
  sync: syncCommand as CommandFn,
  update: updateCommand as CommandFn,
};

const HELP_TEXT = `
agent-bridge — Manage AI tool configurations from multiple sources

Usage: agent-bridge <command> [options]

Commands:
  init     Initialize Agent Bridge (creates .agent-bridge/config.yml)
  sync     Fetch sources, discover features, and sync files
  update   Fetch latest changes for all remote sources

Options:
  --cwd <path>   Override the working directory (defaults to git root or cwd)
  --force        Overwrite existing non-Agent-Bridge git hooks during init
  -h, --help     Show this help
  -v, --version  Show version number
`;

interface ParsedArgs {
  command?: string;
  options: CliOptions;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = {};
  let command: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--cwd') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for --cwd`);
      }
      options.cwd = resolve(value);
      i++;
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = resolve(arg.slice('--cwd='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!command) {
      command = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { command, options, help, version };
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

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  if (parsed.help || !parsed.command || parsed.command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const fn = COMMANDS[parsed.command];
  if (!fn) {
    console.error(`Unknown command: ${parsed.command}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  if (parsed.options.cwd) {
    await assertCwdExists(parsed.options.cwd);
  }

  await fn(parsed.options.cwd, parsed.options);
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
