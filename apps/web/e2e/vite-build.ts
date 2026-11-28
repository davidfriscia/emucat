/**
 * Runs Vite's own command line for the browser tests, on Windows and Linux alike.
 *
 * The tests used to run `execFileSync('npx', ['vite', …])`. Without a shell, Windows resolves an executable only with
 * the `.exe`/`.com` extensions, while npm installs `npx` as `npx.cmd`, so the spawn failed with `ENOENT` before any
 * test ran. A `.cmd` can only be started through `cmd.exe`, which re-parses every argument (`shell: true`), and `npx`
 * may also download a package it does not find. Instead, the Vite CLI of this workspace's `node_modules` (the version
 * the lockfile pins) is run by the Node.js running the tests: no shell, no lookup on `PATH`, arguments passed as they
 * are, and a non-zero exit is thrown by `execFileSync`.
 */
import { execFileSync, type StdioOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');

/** The absolute path of the Vite CLI script that `apps/web` resolves (its package's `bin.vite`). */
export function viteCli(from: string = WEB): string {
  const manifest = createRequire(resolve(from, 'package.json')).resolve('vite/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: string | { vite: string } };
  return resolve(dirname(manifest), typeof bin === 'string' ? bin : bin.vite);
}

/** The command and arguments that run Vite with `args`: this Node.js, then the CLI script. */
export function viteCommand(args: readonly string[]): [command: string, args: string[]] {
  return [process.execPath, [viteCli(), ...args]];
}

/** Runs Vite in `apps/web` with `args`, its output shown by default; throws if Vite cannot start or exits with an error. */
export function runVite(args: readonly string[], stdio: StdioOptions = 'inherit'): void {
  const [command, argv] = viteCommand(args);
  execFileSync(command, argv, { cwd: WEB, stdio });
}
