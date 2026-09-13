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
  isIncluded,
  sourceDomains,
  type BridgeConfig,
  type DomainConfig,
  type ToolConfig,
  type SourceConfig,
} from '../lib/config.js';
import { findRepoRoot, isInGitRepo, installGitHooks } from '../lib/git.js';
import { listDomains, listDomainContents } from '../lib/manifest.js';
import { syncSource, resolveSourcePath, ensureBridgeGitignore } from '../lib/sources.js';
import { treeSelect } from '../lib/tree-prompt.js';
import { type TreeNode } from '../lib/tree.js';
import { VERSION } from '../lib/version.js';
import { syncCommand } from './sync.js';

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

export interface InitOptions {
  force?: boolean;
  domains?: string;
  tools?: string;
  source?: string[];
  hooks?: boolean;
}

// ---------------------------------------------------------------------------
// Argument parsing (shared by interactive and non-interactive mode)
// ---------------------------------------------------------------------------

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

/**
 * Turn a per-domain selection into the `include` list stored in config.
 * Returns `undefined` when everything is selected (= sync the whole domain).
 * A fully selected feature type collapses to its name (`skills`).
 */
export function buildInclude(
  contents: { featureTypes: Array<{ name: string; features: string[] }>; files: string[] },
  selected: Set<string>
): string[] | undefined {
  const include: string[] = [];
  let everything = true;

  for (const ft of contents.featureTypes) {
    const picked = ft.features.filter((f) => selected.has(`${ft.name}/${f}`));
    if (picked.length === ft.features.length) {
      include.push(ft.name);
    } else {
      everything = false;
      include.push(...picked.map((f) => `${ft.name}/${f}`));
    }
  }
  for (const file of contents.files) {
    if (selected.has(file)) include.push(file);
    else everything = false;
  }

  return everything ? undefined : include;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

function cancelled(value: unknown): value is symbol {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return false;
}

/** Clone remote sources / verify local ones. Exits on failure. */
async function fetchSources(repoRoot: string, sources: SourceConfig[]): Promise<void> {
  await ensureBridgeGitignore(repoRoot);
  const s = p.spinner();
  s.start('Fetching sources…');
  const results = await Promise.all(sources.map((src) => syncSource(repoRoot, src)));
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    s.stop('Some sources failed');
    for (const err of errors) p.log.error(`${err.name}: ${err.error}`);
    p.cancel('Fix the source URL/path and run `agent-bridge init` again.');
    process.exit(1);
  }
  s.stop(`${sources.length} source(s) ready`);
}

async function maybeInstallHooks(repoRoot: string, force: boolean): Promise<void> {
  const hookResult = await installGitHooks(repoRoot, force);
  if (hookResult.installed.length > 0) {
    p.log.success(`Installed git hooks: ${hookResult.installed.join(', ')}`);
  }
  if (hookResult.skipped.length > 0) {
    p.log.warn(`Skipped hooks (existing non-Agent-Bridge hooks): ${hookResult.skipped.join(', ')}`);
    p.log.info('Re-run `agent-bridge init --force` to overwrite, or integrate manually.');
  }
  for (const e of hookResult.errors) {
    p.log.error(`Hook ${e.hook}: ${e.error}`);
  }
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

async function promptTools(): Promise<ToolConfig[]> {
  const selected = await p.multiselect({
    message: 'Which tools should receive synced files?',
    options: [...WELL_KNOWN_TOOLS, { value: CUSTOM_TOOL_SENTINEL, label: 'Other (add custom tool)' }],
    required: true,
  });
  cancelled(selected);

  const tools = (selected as ToolConfig[]).filter((t) => t.name !== CUSTOM_TOOL_SENTINEL.name);
  if (!(selected as ToolConfig[]).some((t) => t.name === CUSTOM_TOOL_SENTINEL.name)) return tools;

  for (;;) {
    const name = await p.text({
      message: 'Custom tool name (used for <tool>-- prefix matching)',
      placeholder: 'windsurf',
      validate: (v) => {
        if (!v.trim()) return 'Tool name cannot be empty';
        if (tools.some((t) => t.name === v.trim())) return 'Tool name already used';
      },
    });
    if (p.isCancel(name)) break;

    const folder = await p.text({
      message: `Target folder for "${name}"`,
      placeholder: `.${name}`,
      validate: (v) => {
        if (!v.trim()) return 'Folder cannot be empty';
        if (tools.some((t) => t.folder === v.trim())) return 'Folder already used by another tool';
      },
    });
    if (p.isCancel(folder)) break;

    tools.push({ name: name.trim(), folder: folder.trim() });

    const more = await p.confirm({ message: 'Add another custom tool?', initialValue: false });
    if (p.isCancel(more) || !more) break;
  }

  if (tools.length === 0) {
    p.cancel('At least one tool is required.');
    process.exit(1);
  }
  return tools;
}

async function promptSources(repoRoot: string): Promise<SourceConfig[]> {
  const sources: SourceConfig[] = [];
  p.log.info('Add at least one source — a Git URL or a local folder that follows the domain layout.');

  for (;;) {
    const input = await p.text({
      message: sources.length === 0 ? 'Source URL or local path' : 'Another source URL or local path',
      placeholder: 'https://github.com/org/ai-hub.git',
      validate: (v) => {
        if (!v.trim()) return 'Source URL/path cannot be empty';
        const derived = deriveSourceName(v.trim());
        if (sources.some((s) => s.name === derived))
          return `Source name "${derived}" (derived from URL) already used`;
      },
    });
    if (p.isCancel(input)) {
      if (sources.length === 0) cancelled(input);
      break;
    }

    const entry = parseSourceArg(input, repoRoot);
    if (isRemoteSource(entry.source) && !entry.branch) {
      const branch = await p.text({
        message: 'Branch (leave empty for the remote default)',
        placeholder: 'main',
        defaultValue: '',
      });
      cancelled(branch);
      if ((branch as string).trim()) entry.branch = (branch as string).trim();
    }
    sources.push(entry);

    const more = await p.confirm({ message: 'Add another source?', initialValue: false });
    if (p.isCancel(more) || !more) break;
  }
  return sources;
}

/**
 * One checkbox tree: source → domain → feature type → feature (plus a
 * `files` group per domain). Ticking a node ticks everything beneath it.
 * Returns, per source, the picked domains with their `include` lists
 * (`undefined` include = whole domain).
 */
async function promptSelection(
  repoRoot: string,
  sources: SourceConfig[],
  toolNames: string[],
  /** Existing config whose selection should start ticked (re-run of init). */
  current?: BridgeConfig
): Promise<Map<string, DomainConfig[]>> {
  // Leaf value: `<source>\u0000<domain>\u0000<relPath>`; a domain with no
  // syncable content becomes a leaf with an empty relPath (= whole domain).
  const SEP = '\u0000';
  const contentsByKey = new Map<string, Awaited<ReturnType<typeof listDomainContents>>>();
  const tree: TreeNode[] = [];
  const initialValues: string[] = [];
  const currentDomain = (sourceName: string, domain: string): DomainConfig | undefined => {
    const src = current?.sources.find((s) => s.name === sourceName);
    return src && sourceDomains(current!, src).find((d) => d.name === domain);
  };

  for (const source of sources) {
    const srcPath = resolveSourcePath(repoRoot, source);
    const domains = await listDomains(srcPath);
    if (domains.length === 0) {
      p.log.warn(`${source.name}: no domain folders found — nothing to select.`);
      continue;
    }
    const domainNodes: TreeNode[] = [];
    for (const domain of domains) {
      const contents = await listDomainContents(srcPath, domain, toolNames);
      contentsByKey.set(`${source.name}${SEP}${domain}`, contents);
      const prefix = `${source.name}${SEP}${domain}${SEP}`;
      const existing = currentDomain(source.name, domain);
      const leaf = (rel: string): TreeNode => {
        if (existing && isIncluded(existing, rel)) initialValues.push(`${prefix}${rel}`);
        return { label: rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel, value: `${prefix}${rel}` };
      };
      const children: TreeNode[] = contents.featureTypes
        .filter((ft) => ft.features.length > 0)
        .map((ft) => ({
          label: ft.name,
          hint: `(${ft.features.length})`,
          children: ft.features.map((f) => leaf(`${ft.name}/${f}`)),
        }));
      if (contents.files.length > 0) {
        children.push({ label: 'files', children: contents.files.map((f) => leaf(f)) });
      }
      if (children.length === 0 && existing) initialValues.push(prefix);
      const hint = contents.featureTypes
        .filter((ft) => ft.features.length > 0)
        .map((ft) => `${ft.features.length} ${ft.name}`)
        .join(', ');
      domainNodes.push(
        children.length > 0
          ? { label: domain, hint: hint ? `(${hint})` : undefined, children }
          : { label: domain, hint: '(empty)', value: prefix }
      );
    }
    tree.push({ label: source.name, children: domainNodes });
  }

  if (tree.length === 0) {
    p.cancel('No domains found in any source. Check the source layout: <source>/<domain>/<feature-type>/…');
    process.exit(1);
  }

  const picked = await treeSelect({
    message: 'What do you want to sync? Tick a domain to take all of it, or open it and pick pieces.',
    tree,
    expandDepth: 1,
    initialValues,
    required: true,
  });
  cancelled(picked);

  // Group selected leaves by source/domain, then compress into include lists.
  const byDomain = new Map<string, Set<string>>();
  for (const value of picked as string[]) {
    const [sourceName, domain, rel] = value.split(SEP);
    const key = `${sourceName}${SEP}${domain}`;
    const set = byDomain.get(key) ?? new Set<string>();
    if (rel) set.add(rel);
    byDomain.set(key, set);
  }

  const result = new Map<string, DomainConfig[]>();
  for (const [key, rels] of byDomain) {
    const [sourceName, domain] = key.split(SEP);
    const contents = contentsByKey.get(key)!;
    const include = rels.size === 0 ? undefined : buildInclude(contents, rels);
    const list = result.get(sourceName) ?? [];
    list.push(include ? { name: domain, include } : { name: domain });
    result.set(sourceName, list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function initCommand(cwd?: string, opts?: InitOptions): Promise<void> {
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

  if (hasToolsArg !== hasSourceArg) {
    p.log.error('Both --tools and --source are required for non-interactive init.');
    process.exit(1);
  }

  // --- Non-interactive mode ---
  if (hasToolsArg && hasSourceArg) {
    const tools = parseToolsArg(opts!.tools!);
    const sources = opts!.source!.map((s) => parseSourceArg(s, repoRoot));

    const seen = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.name)) {
        throw new Error(`Duplicate source name "${s.name}" derived from --source arguments`);
      }
      seen.add(s.name);
    }

    await fetchSources(repoRoot, sources);

    const domainsArg = opts!.domains
      ? opts!.domains.split(',').map((d) => d.trim()).filter(Boolean)
      : undefined;
    for (const source of sources) {
      const names = domainsArg ?? (await listDomains(resolveSourcePath(repoRoot, source)));
      source.domains = names.map((name): DomainConfig => ({ name }));
      if (source.domains.length === 0) {
        p.log.warn(`${source.name}: no domains found — add some or pass --domains.`);
      }
    }

    const config: BridgeConfig = { version: VERSION, tools, sources };
    await saveConfig(repoRoot, config);
    p.log.success('Saved .agent-bridge/config.yml');

    if (opts!.hooks && isInGitRepo(repoRoot)) {
      await maybeInstallHooks(repoRoot, opts!.force === true);
    }

    p.outro('Done! Run `agent-bridge sync` to sync features.');
    return;
  }

  // --- Interactive mode ---
  p.intro('Agent Bridge — Project Setup');

  // Re-run on an existing project: keep tools & sources, just re-pick content.
  let existing: BridgeConfig | undefined;
  if (await configExists(repoRoot)) {
    existing = await loadConfig(repoRoot);
    const mode = await p.select({
      message: `Found .agent-bridge/config.yml (${existing.sources.length} source(s), ${existing.tools.length} tool(s)). What do you want to do?`,
      options: [
        { value: 'reselect', label: 'Change what to sync', hint: 'keep tools and sources, re-pick domains and features' },
        { value: 'restart', label: 'Start over', hint: 're-enter tools and sources' },
      ],
    });
    cancelled(mode);
    if (mode === 'restart') existing = undefined;
  }

  // 1. Tools
  const tools = existing ? existing.tools : await promptTools();

  // 2. Sources (then fetch them so we can show what's inside)
  const sources = existing ? existing.sources.map((s) => ({ ...s })) : await promptSources(repoRoot);
  await fetchSources(repoRoot, sources);

  // 3. One tree: domains and their contents, per source (pre-ticked on re-run)
  const picked = await promptSelection(repoRoot, sources, tools.map((t) => t.name), existing);
  for (const source of sources) {
    source.domains = picked.get(source.name) ?? [];
  }
  // Sources without any picked domain contribute nothing — drop them.
  const activeSources = sources.filter((s) => (s.domains?.length ?? 0) > 0);
  for (const s of sources) {
    if (!activeSources.includes(s)) p.log.warn(`${s.name}: no domains selected — source dropped from config.`);
  }

  const config: BridgeConfig = { version: VERSION, tools, sources: activeSources };
  await saveConfig(repoRoot, config);
  p.log.success('Saved .agent-bridge/config.yml — commit this file.');

  // 4. Git hooks (skipped on a re-run: they're already the user's choice)
  if (!existing && isInGitRepo(repoRoot)) {
    const installHooks = await p.confirm({
      message: 'Install git hooks to auto-sync after checkout/merge?',
      initialValue: false,
    });
    if (!p.isCancel(installHooks) && installHooks) {
      await maybeInstallHooks(repoRoot, opts?.force === true);
    }
  }

  // 5. Sync right away
  const syncNow = await p.confirm({ message: 'Run `agent-bridge sync` now?', initialValue: true });
  if (!p.isCancel(syncNow) && syncNow) {
    await syncCommand(repoRoot);
    return;
  }
  p.outro('Done! Run `agent-bridge sync` whenever you want to pull the latest features.');
}
