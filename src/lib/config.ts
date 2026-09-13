import { readFile, writeFile, access, mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const safeName = z
  .string()
  .min(1)
  .refine((v) => SAFE_NAME_RE.test(v) && v !== '.' && v !== '..', {
    message: 'Only [A-Za-z0-9._-] characters allowed, cannot be . or ..',
  });

const safeRelativeFolder = z
  .string()
  .min(1)
  .refine(
    (value) => {
      if (isAbsolute(value) || value.includes('\0')) return false;
      const segments = value.split(/[\\/]/).filter((s) => s.length > 0);
      if (segments.length === 0) return false;
      return segments.every(
        (seg) => seg !== '..' && seg !== '.' && /^\.?[A-Za-z0-9._-]+$/.test(seg)
      );
    },
    { message: 'Must be a relative path using only [A-Za-z0-9._-]' }
  );

const toolConfigSchema = z.object({
  name: safeName.refine((v) => !v.includes('--'), {
    message: "Must not contain '--' (reserved for tool-prefix routing)",
  }),
  folder: safeRelativeFolder,
});

const sourceConfigSchema = z.object({
  name: safeName,
  source: z.string().min(1).refine((v) => !v.startsWith('-'), {
    message: "Must not start with '-'",
  }),
  branch: z
    .string()
    .refine((v) => /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith('-'), {
      message: "Must match [A-Za-z0-9._/-] and not start with '-'",
    })
    .optional(),
});

/**
 * A path inside a domain that should be synced. One or two segments:
 *   `skills`            → the whole feature type
 *   `skills/deploy`     → a single feature (folder or file)
 *   `AGENTS.md`         → a flat file at the domain root
 */
const includePath = z
  .string()
  .min(1)
  .refine(
    (v) => {
      const segs = v.split('/');
      return (
        segs.length <= 2 &&
        segs.every((seg) => SAFE_NAME_RE.test(seg) && seg !== '.' && seg !== '..')
      );
    },
    { message: 'Must be <feature-type>, <feature-type>/<feature> or <file> using [A-Za-z0-9._-]' }
  );

const domainObjectSchema = z.object({
  name: safeName,
  /** Paths to sync from this domain. Omitted = everything. */
  include: z.array(includePath).optional(),
});

/** Domains are written as objects; a bare string (`- shared`) is accepted as shorthand. */
const domainConfigSchema = z.union([
  safeName.transform((name): { name: string; include?: string[] } => ({ name })),
  domainObjectSchema,
]);

const bridgeConfigSchema = z
  .object({
    version: z.string().optional(),
    /**
     * Union of all sources' domains, kept for Agent Bridge ≤ 0.13 which
     * requires it. Also the fallback for sources without their own `domains`.
     */
    domains: z.array(safeName).optional(),
    tools: z.array(toolConfigSchema).min(1, "'tools' must be a non-empty array"),
    sources: z
      .array(sourceConfigSchema.extend({ domains: z.array(domainConfigSchema).optional() }))
      .min(1, "'sources' must be a non-empty array"),
  })
  .superRefine((data, ctx) => {
    data.sources.forEach((s, i) => {
      const domains = s.domains ?? data.domains;
      if (!domains || domains.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Source '${s.name}' has no domains (set 'sources[].domains' or top-level 'domains')`,
          path: ['sources', i, 'domains'],
        });
      }
      const seen = new Set<string>();
      for (const d of s.domains ?? []) {
        if (seen.has(d.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate domain '${d.name}' in source '${s.name}'`,
            path: ['sources', i, 'domains'],
          });
        }
        seen.add(d.name);
      }
    });

    // Check unique tool names
    const toolNames = new Set<string>();
    const toolFolders = new Set<string>();
    data.tools.forEach((t, i) => {
      if (toolNames.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate tool name: '${t.name}'`,
          path: ['tools', i, 'name'],
        });
      }
      toolNames.add(t.name);
      if (toolFolders.has(t.folder)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate tool folder: '${t.folder}'`,
          path: ['tools', i, 'folder'],
        });
      }
      toolFolders.add(t.folder);
    });

    // Check unique source names and branch validity
    const sourceNames = new Set<string>();
    data.sources.forEach((s, i) => {
      if (sourceNames.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate source name: '${s.name}'`,
          path: ['sources', i, 'name'],
        });
      }
      sourceNames.add(s.name);

      const isRemote =
        s.source.startsWith('https://') ||
        s.source.startsWith('http://') ||
        s.source.startsWith('file://') ||
        /^[\w.-]+@[\w.-]+:/.test(s.source);

      if (s.branch && !isRemote) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'branch' is only valid for remote sources",
          path: ['sources', i, 'branch'],
        });
      }
      if (!isRemote && !isAbsolute(s.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Local source paths must be absolute',
          path: ['sources', i, 'source'],
        });
      }
    });
  });

// ---------------------------------------------------------------------------
// Types (inferred from Zod schemas)
// ---------------------------------------------------------------------------

export type SourceType = 'git-https' | 'git-ssh' | 'local';
export type ToolConfig = z.infer<typeof toolConfigSchema>;
export type DomainConfig = z.infer<typeof domainObjectSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema> & { domains?: DomainConfig[] };
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

// ---------------------------------------------------------------------------
// Domain resolution & include filtering
// ---------------------------------------------------------------------------

/**
 * Domains to scan for a source: its own `domains`, falling back to the legacy
 * top-level `domains` list (everything included).
 */
export function sourceDomains(config: BridgeConfig, source: SourceConfig): DomainConfig[] {
  if (source.domains) return source.domains;
  return (config.domains ?? []).map((name) => ({ name }));
}

/**
 * Whether `relPath` (relative to the domain root, e.g. `skills`,
 * `skills/deploy`, `AGENTS.md`) is selected by the domain's `include` list.
 * No `include` means everything is selected.
 */
export function isIncluded(domain: DomainConfig, relPath: string): boolean {
  const inc = domain.include;
  if (!inc) return true;
  return inc.some((entry) => entry === relPath || relPath.startsWith(entry + '/') || entry.startsWith(relPath + '/'));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BRIDGE_DIR = '.agent-bridge';
export const CONFIG_FILENAME = 'config.yml';

/**
 * Tombstone written by `opt-out`. It lives inside `.agent-bridge/` so it's
 * gitignored by default (the directory's `.gitignore` ignores everything but
 * `config.yml`), keeping opt-out local to a machine. `init`/`sync` honor it so
 * a `postinstall` guard doesn't silently reinstall Agent Bridge on the next
 * `npm install`. Force-add it (`git add -f`) to commit a repo-wide opt-out.
 */
export const OPT_OUT_MARKER = join(BRIDGE_DIR, 'optout');

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

export function optOutMarkerPath(repoRoot: string): string {
  return join(repoRoot, OPT_OUT_MARKER);
}

/** Whether an opt-out tombstone is present at the repo root. */
export async function isOptedOut(repoRoot: string): Promise<boolean> {
  try {
    await access(optOutMarkerPath(repoRoot));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the opt-out tombstone inside `.agent-bridge/`. Recreates the directory
 * (opt-out deletes it) and its `.gitignore` so the marker is ignored by default.
 */
export async function writeOptOutMarker(repoRoot: string): Promise<void> {
  const dir = bridgeDir(repoRoot);
  await mkdir(dir, { recursive: true });
  // Same ignore rules init/sync write: ignore everything but the config.
  await writeFile(
    join(dir, '.gitignore'),
    ['# Ignore cloned sources', '*', '!config.yml', '!.gitignore'].join('\n') + '\n',
    'utf-8'
  );
  await writeFile(
    optOutMarkerPath(repoRoot),
    '# Agent Bridge opt-out marker. Remove this file (or run `agent-bridge init --force`) to re-enable.\n',
    'utf-8'
  );
}

/** Remove the opt-out tombstone if present (idempotent). */
export async function removeOptOutMarker(repoRoot: string): Promise<void> {
  await rm(optOutMarkerPath(repoRoot), { force: true });
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

  const result = bridgeConfigSchema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`
    );
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }

  return result.data;
}

export async function saveConfig(
  repoRoot: string,
  config: BridgeConfig
): Promise<void> {
  const dir = bridgeDir(repoRoot);
  await mkdir(dir, { recursive: true });
  // Always write a top-level `domains` list (union of every source's domains).
  // Agent Bridge ≤ 0.13 requires it and ignores `sources[].domains`, so a
  // config written by this version still loads on older installs during a
  // mixed-version rollout (they sync whole domains, without `include`).
  const legacyDomains = [
    ...new Set(config.sources.flatMap((s) => sourceDomains(config, s).map((d) => d.name))),
  ];
  const out = { ...config, domains: legacyDomains.length > 0 ? legacyDomains : config.domains };
  const content = yaml.dump(out, { lineWidth: -1, noRefs: true, skipInvalid: true });
  await writeFile(configPath(repoRoot), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Validation (legacy interface for tests)
// ---------------------------------------------------------------------------

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateConfig(config: unknown): ConfigValidationResult {
  const result = bridgeConfigSchema.safeParse(config);
  if (result.success) {
    return { ok: true, errors: [] };
  }
  const errors = result.error.issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`
  );
  return { ok: false, errors };
}
