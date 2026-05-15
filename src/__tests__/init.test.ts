import { describe, it, expect } from 'vite-plus/test';
import { deriveSourceName, parseToolsArg, parseSourceArg } from '../commands/init.js';

describe('deriveSourceName', () => {
  it('extracts repo name from HTTPS URL', () => {
    expect(deriveSourceName('https://github.com/org/repo.git')).toBe('repo');
  });

  it('extracts repo name from HTTPS URL without .git', () => {
    expect(deriveSourceName('https://github.com/org/repo')).toBe('repo');
  });

  it('extracts repo name from SSH URL', () => {
    expect(deriveSourceName('git@github.com:org/repo.git')).toBe('repo');
  });

  it('extracts repo name from file:// URL', () => {
    expect(deriveSourceName('file:///tmp/bare.git')).toBe('bare');
  });

  it('extracts folder name from local path', () => {
    expect(deriveSourceName('/path/to/my-folder')).toBe('my-folder');
  });

  it('extracts folder name from relative path', () => {
    expect(deriveSourceName('../my-source')).toBe('my-source');
  });

  it('handles trailing slashes', () => {
    expect(deriveSourceName('/path/to/my-folder/')).toBe('my-folder');
  });

  it('returns "source" for empty-ish input', () => {
    expect(deriveSourceName('')).toBe('source');
  });
});

// ---------------------------------------------------------------------------
// parseToolsArg
// ---------------------------------------------------------------------------

describe('parseToolsArg', () => {
  it('parses a single well-known tool', () => {
    expect(parseToolsArg('cursor')).toEqual([{ name: 'cursor', folder: '.cursor' }]);
  });

  it('parses multiple well-known tools', () => {
    const result = parseToolsArg('cursor,vscode,claude');
    expect(result).toEqual([
      { name: 'cursor', folder: '.cursor' },
      { name: 'vscode', folder: '.github' },
      { name: 'claude', folder: '.claude' },
    ]);
  });

  it('parses a custom name:folder tool', () => {
    expect(parseToolsArg('windsurf:.windsurf')).toEqual([
      { name: 'windsurf', folder: '.windsurf' },
    ]);
  });

  it('parses mixed well-known and custom tools', () => {
    const result = parseToolsArg('cursor,windsurf:.windsurf');
    expect(result).toEqual([
      { name: 'cursor', folder: '.cursor' },
      { name: 'windsurf', folder: '.windsurf' },
    ]);
  });

  it('trims whitespace around tool names', () => {
    const result = parseToolsArg(' cursor , vscode ');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('cursor');
    expect(result[1].name).toBe('vscode');
  });

  it('throws for unknown tool name without folder', () => {
    expect(() => parseToolsArg('unknown')).toThrow('Unknown tool "unknown"');
  });

  it('throws for empty tool name', () => {
    expect(() => parseToolsArg('cursor,,vscode')).toThrow('Empty tool name');
  });
});

// ---------------------------------------------------------------------------
// parseSourceArg
// ---------------------------------------------------------------------------

describe('parseSourceArg', () => {
  const repoRoot = '/project';

  it('parses a remote URL', () => {
    const result = parseSourceArg('https://github.com/org/repo.git', repoRoot);
    expect(result.name).toBe('repo');
    expect(result.source).toBe('https://github.com/org/repo.git');
    expect(result.branch).toBeUndefined();
  });

  it('parses a remote URL with #branch suffix', () => {
    const result = parseSourceArg('https://github.com/org/repo.git#main', repoRoot);
    expect(result.name).toBe('repo');
    expect(result.source).toBe('https://github.com/org/repo.git');
    expect(result.branch).toBe('main');
  });

  it('resolves a local path to absolute', () => {
    const result = parseSourceArg('../my-source', repoRoot);
    expect(result.name).toBe('my-source');
    expect(result.source).toMatch(/\/my-source$/);
    expect(result.branch).toBeUndefined();
  });

  it('parses an SSH URL with #branch', () => {
    const result = parseSourceArg('git@github.com:org/repo.git#develop', repoRoot);
    expect(result.name).toBe('repo');
    expect(result.source).toBe('git@github.com:org/repo.git');
    expect(result.branch).toBe('develop');
  });

  it('throws for empty source', () => {
    expect(() => parseSourceArg('', repoRoot)).toThrow('Empty source');
  });
});
