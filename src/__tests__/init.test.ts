import { describe, it, expect } from 'vite-plus/test';
import { deriveSourceName } from '../commands/init.js';

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
