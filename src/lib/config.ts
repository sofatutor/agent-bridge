import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Name / path safety
// ---------------------------------------------------------------------------

/**
 * Characters allowed in identifier-like fields (tool name, source name,
 * domain). Keep this conservative so values are always safe as directory
 * names on any platform.
 */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isSafeName(value: string): boolean {
  return SAFE_NAME_RE.test(value) && value !== '.' && value !== '..';
}

/**
 * Folder paths are relative, use only safe path segments, and never
 * traverse out of the repo root.
 */
function isSafeRelativeFolder(value: string): boolean {
  if (!value.trim()) return false;
  if (isAbsolute(value)) return false;
  if (value.includes('\0')) return false;
  // Normalize separators for a cross-platform check.
  const segments = value.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return false;
    // Allow a single leading dot (e.g. .github) but no other weird chars.
    if (!/^\.?[A-Za-z0-9._-]+$/.test(seg)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceType = 'git-https' | 'git-ssh' | 'local';

export interface ToolConfig {
  name: string;
  folder: string;
}

export interface SourceConfig {
  name: string;
  source: string;
  branch?: string;
}

export interface BridgeConfig {
  version?: string;
  domains: string[];
  tools: ToolConfig[];
  sources: SourceConfig[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BRIDGE_DIR = '.agent-bridge';
export const CONFIG_FILENAME = 'config.yml';

// ---------------------------------------------------------------------------
// Source type detection
// ---------------------------------------------------------------------------

export function detectSourceType(source: string): SourceType {
  if (
    source.startsWith('https://') ||
    source.startsWith('http://') ||
    source.startsWith('file://')
  ) {
    return 'git-https';
  }
  if (/^[\w.-]+@[\w.-]+:/.test(source)) {
    return 'git-ssh';
  }
  return 'local';
}

export function isRemoteSource(source: string): boolean {
  const type = detectSourceType(source);
  return type === 'git-https' || type === 'git-ssh';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function bridgeDir(repoRoot: string): string {
  return join(repoRoot, BRIDGE_DIR);
}

export function configPath(repoRoot: string): string {
  return join(repoRoot, BRIDGE_DIR, CONFIG_FILENAME);
}

export function sourceDir(repoRoot: string, sourceName: string): string {
  return join(repoRoot, BRIDGE_DIR, sourceName);
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

export async function configExists(repoRoot: string): Promise<boolean> {
  try {
    await access(configPath(repoRoot));
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(repoRoot: string): Promise<BridgeConfig> {
  const raw = await readFile(configPath(repoRoot), 'utf-8');
  const data = yaml.load(raw);

  if (!isRecord(data)) {
    throw new Error('Invalid config: config.yml is not a valid YAML object');
  }

  const validation = validateConfig(data);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }

  return data as unknown as BridgeConfig;
}

export async function saveConfig(
  repoRoot: string,
  config: BridgeConfig
): Promise<void> {
  const dir = bridgeDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
  await writeFile(configPath(repoRoot), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = [];

  if (!isRecord(config)) {
    return {
      ok: false,
      errors: ['Config must be a YAML object'],
    };
  }

  const domains = config.domains;
  const tools = config.tools;
  const sources = config.sources;

  // domains
  if (!Array.isArray(domains) || domains.length === 0) {
    errors.push("'domains' must be a non-empty array of strings");
  } else {
    for (const d of domains) {
      if (typeof d !== 'string' || !d.trim()) {
        errors.push('Invalid domain: each domain must be a non-empty string');
        break;
      }
      if (!isSafeName(d.trim())) {
        errors.push(
          `Invalid domain '${d}': only [A-Za-z0-9._-] characters are allowed`
        );
      }
    }
  }

  // tools
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push("'tools' must be a non-empty array");
  } else {
    const toolNames = new Set<string>();
    const toolFolders = new Set<string>();
    for (const t of tools) {
      if (!isRecord(t)) {
        errors.push('Each tool must be an object');
        continue;
      }

      const name = t.name;
      const folder = t.folder;

      if (!name || typeof name !== 'string') {
        errors.push("Each tool must have a non-empty 'name'");
      }
      if (!folder || typeof folder !== 'string') {
        errors.push("Each tool must have a non-empty 'folder'");
      }

      if (typeof name !== 'string') {
        continue;
      }

      if (!isSafeName(name)) {
        errors.push(
          `Invalid tool name '${name}': only [A-Za-z0-9._-] characters are allowed`
        );
      }
      if (name.includes('--')) {
        errors.push(
          `Invalid tool name '${name}': must not contain '--' (reserved for tool-prefix routing)`
        );
      }
      if (toolNames.has(name)) {
        errors.push(`Duplicate tool name: '${name}'`);
      }
      toolNames.add(name);

      if (typeof folder === 'string') {
        if (!isSafeRelativeFolder(folder)) {
          errors.push(
            `Invalid tool folder '${folder}' for tool '${name}': must be a relative path using only [A-Za-z0-9._-]`
          );
        } else if (toolFolders.has(folder)) {
          errors.push(
            `Duplicate tool folder '${folder}' (tools must target distinct folders)`
          );
        }
        toolFolders.add(folder);
      }
    }
  }

  // sources
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push("'sources' must be a non-empty array");
  } else {
    const sourceNames = new Set<string>();
    for (const s of sources) {
      if (!isRecord(s)) {
        errors.push('Each source must be an object');
        continue;
      }

      const name = s.name;
      const source = s.source;
      const branch = s.branch;

      if (!name || typeof name !== 'string') {
        errors.push("Each source must have a non-empty 'name'");
      }
      if (!source || typeof source !== 'string') {
        errors.push("Each source must have a non-empty 'source' URL or path");
      }

      if (typeof name === 'string') {
        if (!isSafeName(name)) {
          errors.push(
            `Invalid source name '${name}': only [A-Za-z0-9._-] characters are allowed`
          );
        }
        if (sourceNames.has(name)) {
          errors.push(`Duplicate source name: '${name}'`);
        }
        sourceNames.add(name);
      }

      if (branch !== undefined && branch !== null) {
        if (typeof branch !== 'string' || !branch.trim()) {
          errors.push(
            `Source '${String(name)}': 'branch' must be a non-empty string`
          );
        } else if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
          errors.push(
            `Source '${String(name)}': invalid branch '${branch}' (allowed: [A-Za-z0-9._/-], must not start with '-')`
          );
        } else if (typeof source === 'string' && !isRemoteSource(source)) {
          errors.push(
            `Source '${String(name)}': 'branch' is only valid for remote sources`
          );
        }
      }

      if (typeof source === 'string') {
        if (source.startsWith('-')) {
          errors.push(
            `Source '${String(name)}': source must not start with '-' (got '${source}')`
          );
        }
        if (!isRemoteSource(source) && !isAbsolute(source)) {
          errors.push(
            `Source '${String(name)}': local source paths must be absolute (got '${source}')`
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
