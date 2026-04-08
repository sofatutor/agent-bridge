import { execSync } from 'node:child_process';

export function findRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return process.cwd();
  }
}
