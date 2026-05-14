import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeConfig, SourceConfig } from './config.js';
import { dirExists, fileExists } from './fs.js';
import { resolveSourcePath } from './sources.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const TOOL_PREFIX_SEPARATOR = '--';

export interface Feature {
  name: string;
  /** Raw feature-type directory name (may contain tool prefix) */
  type: string;
  /** Display type with tool prefix stripped (used for destination dir) */
  displayType: string;
  source: string;
  domain: string;
  /** Absolute path to the feature (directory or file) */
  absolutePath: string;
  /** Tool prefix if present (e.g. "cursor" from "cursor--instructions") */
  toolPrefix?: string;
  /** True if feature is a single file, false if a directory */
  isFile: boolean;
}

export interface DuplicateConflict {
  name: string;
  type: string;
  paths: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { dirExists } from './fs.js';


export function parseToolPrefix(name: string): {
  toolPrefix?: string;
  baseName: string;
} {
  const idx = name.indexOf(TOOL_PREFIX_SEPARATOR);
  if (idx > 0) {
    return {
      toolPrefix: name.substring(0, idx),
      baseName: name.substring(idx + TOOL_PREFIX_SEPARATOR.length),
    };
  }
  return { baseName: name };
}

export function featureMatchesTool(
  feature: Feature,
  toolName: string
): boolean {
  if (!feature.toolPrefix) return true;
  return feature.toolPrefix === toolName;
}

export function featureName(feature: Feature): string {
  if (feature.toolPrefix) {
    return parseToolPrefix(feature.name).baseName;
  }
  return feature.name;
}

/** @deprecated Use featureName instead */
/** @deprecated Use featureName directly */
export const syncName = featureName;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover all feature types across all sources and domains.
 */
export async function discoverFeatureTypes(
  repoRoot: string,
  config: BridgeConfig
): Promise<string[]> {
  const types = new Set<string>();

  for (const source of config.sources) {
    const srcPath = resolveSourcePath(repoRoot, source);
    for (const domain of config.domains) {
      const domainDir = join(srcPath, domain);
      if (!(await dirExists(domainDir))) continue;

      const entries = await readdir(domainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !parseToolRootName(entry.name)) {
          types.add(entry.name);
        }
      }
    }
  }

  return [...types].sort();
}

/**
 * Scan all features across sources × domains × feature types.
 *
 * Structure: `<source-path>/<domain>/<feature-type>/<feature>/` (folder-based)
 *         or `<source-path>/<domain>/<feature-type>/<feature.ext>` (file-based)
 */
export async function scanFeatures(
  repoRoot: string,
  config: BridgeConfig,
  featureTypes: string[]
): Promise<Feature[]> {
  const features: Feature[] = [];

  for (const source of config.sources) {
    const srcPath = resolveSourcePath(repoRoot, source);

    for (const domain of config.domains) {
      for (const ft of featureTypes) {
        const { toolPrefix: typeToolPrefix, baseName: baseType } =
          parseToolPrefix(ft);
        const ftDir = join(srcPath, domain, ft);

        if (!(await dirExists(ftDir))) continue;

        const entries = await readdir(ftDir, { withFileTypes: true });
        for (const entry of entries) {
          const isFile = entry.isFile();
          const isDir = entry.isDirectory();
          if (!isFile && !isDir) continue;

          const { toolPrefix: itemToolPrefix } = parseToolPrefix(entry.name);
          const toolPrefix = itemToolPrefix ?? typeToolPrefix;

          features.push({
            name: entry.name,
            type: ft,
            displayType: baseType,
            source: source.name,
            domain,
            absolutePath: join(ftDir, entry.name),
            toolPrefix,
            isFile,
          });
        }
      }
    }
  }

  return features;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export function detectDuplicates(features: Feature[]): DuplicateConflict[] {
  const byKey = new Map<string, Feature[]>();

  for (const f of features) {
    const linkName = featureName(f);
    const key = `${f.displayType}/${linkName}`;
    const group = byKey.get(key) ?? [];
    group.push(f);
    byKey.set(key, group);
  }

  const conflicts: DuplicateConflict[] = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      conflicts.push({
        name: featureName(group[0]),
        type: group[0].type,
        paths: group.map((f) => f.absolutePath),
      });
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Root file scanning
// ---------------------------------------------------------------------------

/**
 * Well-known root files that live at the domain root and should be synced to the
 * workspace root. When a source contains `<domain>/AGENTS.md` (etc.), Agent Bridge
 * copies it to the project root.
 */
export const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md'] as const;
export type RootFileName = (typeof ROOT_FILES)[number];

export interface RootFile {
  /** The well-known filename (e.g. "AGENTS.md") */
  fileName: RootFileName;
  /** Source that provides this file */
  source: string;
  /** Domain where it was found */
  domain: string;
  /** Absolute path to the source file */
  absolutePath: string;
}

export interface RootFileDuplicate {
  fileName: RootFileName;
  paths: string[];
}

/**
 * Scan all sources × domains for well-known root files.
 * Returns one entry per found file.
 */
export async function scanRootFiles(
  repoRoot: string,
  config: BridgeConfig
): Promise<RootFile[]> {
  const found: RootFile[] = [];

  for (const source of config.sources) {
    const srcPath = resolveSourcePath(repoRoot, source);
    for (const domain of config.domains) {
      for (const fileName of ROOT_FILES) {
        const filePath = join(srcPath, domain, fileName);
        if (await fileExists(filePath)) {
          found.push({
            fileName,
            source: source.name,
            domain,
            absolutePath: filePath,
          });
        }
      }
    }
  }

  return found;
}

/**
 * Detect duplicate root files (same filename provided by multiple sources/domains).
 */
export function detectRootFileDuplicates(
  rootFiles: RootFile[]
): RootFileDuplicate[] {
  const byName = new Map<RootFileName, RootFile[]>();
  for (const rf of rootFiles) {
    const group = byName.get(rf.fileName) ?? [];
    group.push(rf);
    byName.set(rf.fileName, group);
  }

  const duplicates: RootFileDuplicate[] = [];
  for (const [fileName, group] of byName) {
    if (group.length > 1) {
      duplicates.push({
        fileName,
        paths: group.map((rf) => rf.absolutePath),
      });
    }
  }

  return duplicates;
}

// ---------------------------------------------------------------------------
// Tool root folder scanning (_tool convention)
// ---------------------------------------------------------------------------

/**
 * Prefix used to identify tool root folders in source repos.
 * A folder named `_cursor` maps to the tool named "cursor" and its contents
 * are synced directly into the tool's root folder (e.g. `.cursor/`).
 */
const TOOL_ROOT_PREFIX = '_';

export interface ToolRootEntry {
  /** The tool name this entry targets (e.g. "pi") */
  toolName: string;
  /** Name of the file or folder inside the _tool directory */
  name: string;
  /** Source that provides this entry */
  source: string;
  /** Domain where it was found */
  domain: string;
  /** Absolute path to the source file or folder */
  absolutePath: string;
  /** True if the entry is a single file, false if a directory */
  isFile: boolean;
}

export interface ToolRootDuplicate {
  /** The tool name */
  toolName: string;
  /** Name of the duplicate entry */
  name: string;
  /** Paths where the duplicates were found */
  paths: string[];
}

/**
 * Parse a `_tool` directory name. Returns the tool name if the directory
 * matches the convention, otherwise undefined.
 */
export function parseToolRootName(name: string): string | undefined {
  if (name.startsWith(TOOL_ROOT_PREFIX) && name.length > 1) {
    return name.substring(TOOL_ROOT_PREFIX.length);
  }
  return undefined;
}

/**
 * Scan all sources × domains for `_tool` directories and their contents.
 * Each file/folder inside a `_tool` directory becomes a ToolRootEntry.
 */
export async function scanToolRootEntries(
  repoRoot: string,
  config: BridgeConfig
): Promise<ToolRootEntry[]> {
  const entries: ToolRootEntry[] = [];
  const toolNames = new Set(config.tools.map((t) => t.name));

  for (const source of config.sources) {
    const srcPath = resolveSourcePath(repoRoot, source);
    for (const domain of config.domains) {
      const domainDir = join(srcPath, domain);
      if (!(await dirExists(domainDir))) continue;

      const domainEntries = await readdir(domainDir, { withFileTypes: true });
      for (const dirEntry of domainEntries) {
        if (!dirEntry.isDirectory()) continue;
        const toolName = parseToolRootName(dirEntry.name);
        if (!toolName || !toolNames.has(toolName)) continue;

        const toolRootDir = join(domainDir, dirEntry.name);
        const contents = await readdir(toolRootDir, { withFileTypes: true });
        for (const item of contents) {
          const isFile = item.isFile();
          const isDir = item.isDirectory();
          if (!isFile && !isDir) continue;

          entries.push({
            toolName,
            name: item.name,
            source: source.name,
            domain,
            absolutePath: join(toolRootDir, item.name),
            isFile,
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Detect duplicate tool root entries (same tool + name from multiple sources/domains).
 */
export function detectToolRootDuplicates(
  entries: ToolRootEntry[]
): ToolRootDuplicate[] {
  const byKey = new Map<string, ToolRootEntry[]>();
  for (const entry of entries) {
    const key = `${entry.toolName}/${entry.name}`;
    const group = byKey.get(key) ?? [];
    group.push(entry);
    byKey.set(key, group);
  }

  const duplicates: ToolRootDuplicate[] = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      duplicates.push({
        toolName: group[0].toolName,
        name: group[0].name,
        paths: group.map((e) => e.absolutePath),
      });
    }
  }

  return duplicates;
}
