import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import {
  configExists,
  isRemoteSource,
  loadConfig,
  saveConfig,
  type BridgeConfig,
  type ToolConfig,
  type SourceConfig,
} from '../lib/config.js';
import { findRepoRoot, isInGitRepo, installGitHooks } from '../lib/git.js';
import { syncAllSources } from '../lib/sources.js';
import { VERSION } from '../lib/version.js';

const WELL_KNOWN_TOOLS = [
  { value: { name: 'vscode', folder: '.github' }, label: 'VS Code (.github/)' },
  { value: { name: 'cursor', folder: '.cursor' }, label: 'Cursor (.cursor/)' },
  { value: { name: 'claude', folder: '.claude' }, label: 'Claude (.claude/)' },
];

const CUSTOM_TOOL_SENTINEL: ToolConfig = { name: '__custom__', folder: '__custom__' };

const DEFAULT_DOMAINS = ['backend', 'frontend', 'shared'];

export async function initCommand(
  cwd?: string,
  opts?: { force?: boolean }
): Promise<void> {
  const repoRoot = cwd ?? findRepoRoot();

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
    const name = await p.text({
      message: 'Source name',
      placeholder: 'company-standards',
      defaultValue: '',
      validate: (v) => {
        if (!v.trim()) return 'Source name cannot be empty';
        if (sources.some((s) => s.name === v.trim()))
          return 'Source name already used';
      },
    });
    if (p.isCancel(name)) return false;

    const source = await p.text({
      message: 'Source URL or local path',
      placeholder: 'https://github.com/org/repo.git',
      defaultValue: '',
      validate: (v) => {
        if (!v.trim()) return 'Source URL/path cannot be empty';
      },
    });
    if (p.isCancel(source)) return false;

    const entry: SourceConfig = { name: name.trim(), source: source.trim() };

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
