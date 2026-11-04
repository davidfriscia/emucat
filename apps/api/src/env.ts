import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Loads the repository's `.env`, if any. Variables already set in the environment win. */
export function loadDotEnv(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
