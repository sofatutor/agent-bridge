import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
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

const bridgeConfigSchema = z
  .object({
    version: z.string().optional(),
    domains: z.array(safeName).min(1, "'domains' must be a non-empty array"),
    tools: z.array(toolConfigSchema).min(1, "'tools' must be a non-empty array"),
    sources: z.array(sourceConfigSchema).min(1, "'sources' must be a non-empty array"),
  })
  .superRefine((data, ctx) => {
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
export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

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
  const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
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
