import { readFileSync } from 'node:fs';

/**
 * Reads a `KEY=VALUE` file without evaluating anything: no shell, no quotes, no expansion. Comments and
 * blank lines are skipped. The same rules as `emucatctl` and Docker Compose `env_file`, so one file means
 * the same thing to all three.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    values.set(match[1] as string, match[2] as string);
  }
  return values;
}

export function readEnvFile(path: string): Map<string, string> {
  return parseEnvFile(readFileSync(path, 'utf8'));
}
