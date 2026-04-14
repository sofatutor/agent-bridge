import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeConfig, SourceConfig } from './config.js';
import { dirExists } from './fs.js';
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
        if (entry.isDirectory()) types.add(entry.name);
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
