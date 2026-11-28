/**
 * The browser tests' build launcher (`e2e/vite-build.ts`). It replaced `execFileSync('npx', …)`, which fails with
 * `ENOENT` on Windows (npm's `npx` is `npx.cmd` there, and a `.cmd` is not found without a shell). These tests run with
 * the rest of the web suite on Windows and Linux, so a launcher that only works on one of them fails here first.
 * They run in the suite's jsdom environment (its setup needs `document`); they use only Node.js APIs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVite, viteCli, viteCommand } from '../e2e/vite-build';

const viteVersion = () =>
  (
    JSON.parse(readFileSync(join(dirname(dirname(viteCli())), 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

describe('the browser tests’ Vite launcher', () => {
  it('runs the workspace’s own Vite CLI script with this Node.js, never a command looked up on PATH', () => {
    const cli = viteCli();
    expect(isAbsolute(cli)).toBe(true);
    expect(existsSync(cli)).toBe(true);
    expect(cli.split(sep)).toContain('vite');
    expect(cli.endsWith(join('bin', 'vite.js'))).toBe(true);

    const [command, args] = viteCommand(['build', '--logLevel', 'warn']);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([cli, 'build', '--logLevel', 'warn']);
  });

  it('starts on this platform without a shell, and reports the locked Vite version', () => {
    const [command, args] = viteCommand(['--version']);
    const output = execFileSync(command, args, { encoding: 'utf8' });
    expect(output).toContain(viteVersion());
  });

  it('keeps an argument with spaces as one argument', () => {
    const directory = mkdtempSync(join(tmpdir(), 'emucat vite launcher '));
    try {
      // Vite reports the missing configuration file by the exact path it was given.
      const missing = join(directory, 'no such config.ts');
      const [command, args] = viteCommand(['build', '--config', missing, '--logLevel', 'error']);
      let failure: unknown;
      try {
        execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status: 1 });
      expect(String((failure as { stderr: string }).stderr)).toContain('no such config.ts');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('throws when Vite exits with an error, so a failed build stops the browser tests', () => {
    expect(() =>
      runVite(
        ['build', '--config', 'e2e/this-config-does-not-exist.ts', '--logLevel', 'error'],
        'pipe',
      ),
    ).toThrow(/Command failed/);
  });
});
