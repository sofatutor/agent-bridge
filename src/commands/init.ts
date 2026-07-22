import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import {
  configExists,
  isRemoteSource,
  loadConfig,
  saveConfig,
  isOptedOut,
  removeOptOutMarker,
  OPT_OUT_MARKER,
  type BridgeConfig,
  type ToolConfig,
  type SourceConfig,
} from '../lib/config.js';
import { findRepoRoot, isInGitRepo, installGitHooks } from '../lib/git.js';
import { syncAllSources, ensureBridgeGitignore } from '../lib/sources.js';
import { VERSION } from '../lib/version.js';

const WELL_KNOWN_TOOLS = [
  { value: { name: 'vscode', folder: '.github' }, label: 'VS Code (.github/)' },
  { value: { name: 'cursor', folder: '.cursor' }, label: 'Cursor (.cursor/)' },
  { value: { name: 'claude', folder: '.claude' }, label: 'Claude (.claude/)' },
  { value: { name: 'pi', folder: '.pi' }, label: 'Pi (.pi/)' },
];

const WELL_KNOWN_TOOL_MAP: Record<string, ToolConfig> = Object.fromEntries(
  WELL_KNOWN_TOOLS.map((t) => [t.value.name, t.value])
);

const CUSTOM_TOOL_SENTINEL: ToolConfig = { name: '__custom__', folder: '__custom__' };

const DEFAULT_DOMAINS = ['backend', 'frontend', 'shared'];

export interface InitOptions {
  force?: boolean;
  domains?: string;
  tools?: string;
  source?: string[];
  hooks?: boolean;
}

/**
 * Derive a short source name from a URL or local path.
 *
 * Examples:
 *   https://github.com/org/repo.git  → repo
 *   git@github.com:org/repo.git      → repo
 *   file:///tmp/bare.git             → bare
 *   /path/to/my-folder               → my-folder
 */
export function deriveSourceName(source: string): string {
  let segment = source;

  // SSH: git@host:org/repo.git → org/repo.git
  const sshMatch = segment.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  if (sshMatch) segment = sshMatch[1];

  // Strip protocol + host for URLs
  try {
    const url = new URL(segment);
    segment = url.pathname;
  } catch {
    // not a URL — keep as-is (local path or already stripped)
  }

  // Take the last path component, strip trailing slashes and .git suffix
  const base = segment.replace(/\/+$/, '').split('/').pop() ?? segment;
  return base.replace(/\.git$/, '') || 'source';
}

/**
 * Parse a comma-separated `--tools` argument into ToolConfig[].
 * Accepts well-known names (cursor, vscode, claude) or `name:folder` pairs.
 */
export function parseToolsArg(input: string): ToolConfig[] {
  return input.split(',').map((t) => {
    const trimmed = t.trim();
    if (!trimmed) throw new Error('Empty tool name in --tools');

    if (WELL_KNOWN_TOOL_MAP[trimmed]) return WELL_KNOWN_TOOL_MAP[trimmed];

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      return { name: trimmed.slice(0, colonIdx), folder: trimmed.slice(colonIdx + 1) };
    }

    throw new Error(
      `Unknown tool "${trimmed}". Use a known name (${Object.keys(WELL_KNOWN_TOOL_MAP).join(', ')}) or name:folder format.`
    );
  });
}

/**
 * Parse a single `--source` argument into a SourceConfig.
 * Supports `#branch` suffix for remote sources.
 */
export function parseSourceArg(input: string, repoRoot: string): SourceConfig {
  let source = input.trim();
  let branch: string | undefined;

  const hashIdx = source.lastIndexOf('#');
  if (hashIdx > 0) {
    branch = source.slice(hashIdx + 1);
    source = source.slice(0, hashIdx);
  }

  if (!source) throw new Error('Empty source in --source');

  const name = deriveSourceName(source);
  const entry: SourceConfig = { name, source };

  if (!isRemoteSource(entry.source)) {
    entry.source = resolve(repoRoot, entry.source);
  }

  if (branch) {
    entry.branch = branch;
  }

  return entry;
}

export async function initCommand(
  cwd?: string,
  opts?: InitOptions
): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

  // Respect an opt-out tombstone so a postinstall guard doesn't reinstall.
  // `--force` clears it (deliberate re-opt-in).
  if (await isOptedOut(repoRoot)) {
    if (opts?.force) {
      await removeOptOutMarker(repoRoot);
    } else {
      p.log.warn(
        `${OPT_OUT_MARKER} present — Agent Bridge is opted out. ` +
          `Skipping init. Delete the file or run with --force to re-enable.`
      );
      return;
    }
  }

  const hasToolsArg = !!opts?.tools;
  const hasSourceArg = !!(opts?.source && opts.source.length > 0);

  // Require both --tools and --source for non-interactive mode
  if (hasToolsArg !== hasSourceArg) {
    p.log.error('Both --tools and --source are required for non-interactive init.');
    process.exit(1);
  }

  // --- Non-interactive mode ---
  if (hasToolsArg && hasSourceArg) {
    const domains = opts!.domains
      ? opts!.domains.split(',').map((d) => d.trim()).filter(Boolean)
      : [...DEFAULT_DOMAINS];

    const tools = parseToolsArg(opts!.tools!);
    const sources = opts!.source!.map((s) => parseSourceArg(s, repoRoot));

    // Check duplicate source names
    const seen = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.name)) {
        throw new Error(`Duplicate source name "${s.name}" derived from --source arguments`);
      }
      seen.add(s.name);
    }

    const config: BridgeConfig = {
      version: VERSION,
      domains,
      tools,
      sources,
    };

    await saveConfig(repoRoot, config);
    await ensureBridgeGitignore(repoRoot);
    p.log.success('Saved .agent-bridge/config.yml');

    // Fetch remote sources
    const spinner = p.spinner();
    spinner.start('Fetching remote sources…');
    const results = await syncAllSources(repoRoot, config);
    const fetchErrors = results.filter((r) => r.error);
    if (fetchErrors.length > 0) {
      spinner.stop('Some sources failed');
      for (const err of fetchErrors) {
        p.log.error(`${err.name}: ${err.error}`);
      }
    } else {
      spinner.stop('All sources ready');
    }

    // Git hooks (--hooks flag)
    if (opts!.hooks && isInGitRepo(repoRoot)) {
      const hookResult = await installGitHooks(repoRoot, opts!.force === true);
      if (hookResult.installed.length > 0) {
        p.log.success(`Installed git hooks: ${hookResult.installed.join(', ')}`);
      }
      if (hookResult.skipped.length > 0) {
        p.log.warn(`Skipped hooks: ${hookResult.skipped.join(', ')}`);
      }
      if (hookResult.errors.length > 0) {
        for (const e of hookResult.errors) {
          p.log.error(`Hook ${e.hook}: ${e.error}`);
        }
      }
    }

    p.outro('Done! Run `agent-bridge sync` to sync features.');
    return;
  }

  // --- Interactive mode ---

  p.intro('Welcome to Agent Bridge — Project Setup');

  if (await configExists(repoRoot)) {
    const existing = await loadConfig(repoRoot);
    p.log.info(
      `Config already exists with ${existing.sources?.length ?? 0} source(s). Re-running will overwrite.`
    );
  }

  // --- Domains ---
  const domainsInput = await p.text({
    message: 'Domains (comma-separated)',
    placeholder: DEFAULT_DOMAINS.join(', '),
    defaultValue: DEFAULT_DOMAINS.join(', '),
    validate: (v) => {
      if (!v.trim()) return 'At least one domain is required';
    },
  });
  if (p.isCancel(domainsInput)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }

  const domains = domainsInput
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  // --- Tools ---
  const selectedTools = await p.multiselect({
    message: 'Which tools (IDEs) should receive Agent Bridge files?',
    options: [
      ...WELL_KNOWN_TOOLS,
      { value: CUSTOM_TOOL_SENTINEL, label: 'Other (add custom tool)' },
    ],
    required: true,
  });
  if (p.isCancel(selectedTools)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }

  const tools: ToolConfig[] = (selectedTools as ToolConfig[]).filter(
    (t) => t.name !== '__custom__'
  );

  // If the user selected the custom option, prompt for custom tools
  if ((selectedTools as ToolConfig[]).some((t) => t.name === '__custom__')) {
    let addingCustom = true;
    while (addingCustom) {
      const name = await p.text({
        message: 'Custom tool name (used for <tool>-- prefix matching)',
        placeholder: 'windsurf',
        defaultValue: '',
        validate: (v) => {
          if (!v.trim()) return 'Tool name cannot be empty';
          if (tools.some((t) => t.name === v.trim())) return 'Tool name already used';
        },
      });
      if (p.isCancel(name)) break;

      const folder = await p.text({
        message: `Target folder for "${name}"`,
        placeholder: `.${name}`,
        defaultValue: '',
        validate: (v) => {
          if (!v.trim()) return 'Folder cannot be empty';
          if (tools.some((t) => t.folder === v.trim())) return 'Folder already used by another tool';
        },
      });
      if (p.isCancel(folder)) break;

      tools.push({ name: name.trim(), folder: folder.trim() });

      const addMore = await p.confirm({
        message: 'Add another custom tool?',
        initialValue: false,
      });
      if (p.isCancel(addMore) || !addMore) {
        addingCustom = false;
      }
    }

    if (tools.length === 0) {
      p.cancel('At least one tool is required.');
      process.exit(1);
    }
  }

  // --- Sources ---
  const sources: SourceConfig[] = [];

  const addSource = async (): Promise<boolean> => {
    const source = await p.text({
      message: 'Source URL or local path',
      placeholder: 'https://github.com/org/repo.git',
      defaultValue: '',
      validate: (v) => {
        if (!v.trim()) return 'Source URL/path cannot be empty';
        const derived = deriveSourceName(v.trim());
        if (sources.some((s) => s.name === derived))
          return `Source name "${derived}" (derived from URL) already used`;
      },
    });
    if (p.isCancel(source)) return false;

    const name = deriveSourceName(source.trim());
    const entry: SourceConfig = { name, source: source.trim() };

    // Resolve local paths to absolute
    if (!isRemoteSource(entry.source)) {
      entry.source = resolve(repoRoot, entry.source);
    }

    // Ask for branch if remote
    if (isRemoteSource(entry.source)) {
      const branch = await p.text({
        message: 'Branch (leave empty for remote default)',
        placeholder: 'main',
        defaultValue: '',
      });
      if (p.isCancel(branch)) return false;
      if (branch.trim()) {
        entry.branch = branch.trim();
      }
    }

    sources.push(entry);
    return true;
  };

  p.log.info('Add at least one source.');
  let addingSource = true;
  while (addingSource) {
    const added = await addSource();
    if (!added) {
      if (sources.length === 0) {
        p.cancel('At least one source is required.');
        process.exit(1);
      }
      break;
    }

    const addMore = await p.confirm({
      message: 'Add another source?',
      initialValue: false,
    });
    if (p.isCancel(addMore) || !addMore) {
      addingSource = false;
    }
  }

  const config: BridgeConfig = {
    version: VERSION,
    domains,
    tools,
    sources,
  };

  await saveConfig(repoRoot, config);
  await ensureBridgeGitignore(repoRoot);
  p.log.success('Saved .agent-bridge/config.yml');

  // Clone remote sources
  const s = p.spinner();
  s.start('Fetching remote sources…');
  const results = await syncAllSources(repoRoot, config);
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    s.stop('Some sources failed');
    for (const err of errors) {
      p.log.error(`${err.name}: ${err.error}`);
    }
  } else {
    s.stop('All sources ready');
  }

  // --- Git Hooks ---
  if (isInGitRepo(repoRoot)) {
    const installHooks = await p.confirm({
      message: 'Install git hooks to auto-sync on checkout/merge?',
      initialValue: false,
    });

    if (!p.isCancel(installHooks) && installHooks) {
      const hookResult = await installGitHooks(repoRoot, opts?.force === true);
      
      if (hookResult.installed.length > 0) {
        p.log.success(`Installed git hooks: ${hookResult.installed.join(', ')}`);
      }
      
      if (hookResult.skipped.length > 0) {
        p.log.warn(
          `Skipped hooks (existing non-Agent-Bridge hooks): ${hookResult.skipped.join(', ')}`
        );
        p.log.info('Re-run `agent-bridge init --force` to overwrite, or integrate manually.');
      }
      
      if (hookResult.errors.length > 0) {
        for (const err of hookResult.errors) {
          p.log.error(`Hook ${err.hook}: ${err.error}`);
        }
      }
    }
  }

  p.outro('Done! Run `agent-bridge sync` to sync features.');
}
