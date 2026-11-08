import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployerConfig } from '../src/config.ts';
import { createSanitizer } from '../src/sanitize.ts';
import { DeploymentService, type CheckResult, type HostRunner } from '../src/service.ts';

export const TOKEN = 'deployer-test-token-with-plenty-of-characters';
export const CURRENT = 'a'.repeat(40);
export const LATEST = 'b'.repeat(40);

/** What the fake host was asked to do, and how it behaves. */
export class FakeRunner implements HostRunner {
  started: { operationId: string; expectedCommit: string; requestedBy: string }[] = [];
  alive = new Set<number>();
  lock = false;
  isHealthy = true;
  nextPid = 4000;
  checkResult: CheckResult | Error = {
    remote: { commit: LATEST, subject: 'Next', committedAt: null },
  };
  onCheck: () => void = () => undefined;

  startUpdate(operationId: string, expectedCommit: string, requestedBy: string): number {
    this.started.push({ operationId, expectedCommit, requestedBy });
    const pid = this.nextPid++;
    this.alive.add(pid);
    return pid;
  }
  isAlive(pid: number) {
    return this.alive.has(pid);
  }
  async lockHeld() {
    return this.lock;
  }
  async checkUpdate() {
    this.onCheck();
    if (this.checkResult instanceof Error) throw this.checkResult;
    return this.checkResult;
  }
  async healthy() {
    return this.isHealthy;
  }
}

export interface World {
  root: string;
  config: DeployerConfig;
  runner: FakeRunner;
  service: DeploymentService;
  /** Appends a line to an operation's events, as emucatctl does. */
  event(id: string, key: string, value?: string, message?: string, at?: string): void;
  setCurrent(commit: string): void;
  setRemote(commit: string, subject?: string): void;
  cleanup(): void;
}

export function socketPathForTests(): string {
  const name = `emucat-deployer-unit-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

export function createWorld(overrides: Partial<DeployerConfig> = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'emucat-deployer-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const config: DeployerConfig = {
    environment: 'test',
    branch: 'develop',
    updatesEnabled: true,
    root,
    stateDir,
    operationsDir: join(stateDir, 'operations'),
    ctlPath: '/opt/emucat/tooling/bin/emucatctl',
    configPath: '/opt/emucat/config/deploy.env',
    socketPath: socketPathForTests(),
    tokenFile: join(root, 'token'),
    appEnvFile: join(root, 'app.env'),
    healthUrl: 'http://127.0.0.1:8080/api/v1/ready',
    ...overrides,
  };
  const runner = new FakeRunner();
  const service = new DeploymentService({
    config,
    runner,
    sanitize: createSanitizer(['database-password-value', TOKEN]),
  });
  return {
    root,
    config,
    runner,
    service,
    event(id, key, value = '', message = '', at = new Date().toISOString()) {
      appendFileSync(
        join(config.operationsDir, `${id}.events`),
        `${at}\t${key}\t${value}\t${message}\n`,
      );
    },
    setCurrent(commit) {
      writeFileSync(
        join(stateDir, 'current-release.json'),
        JSON.stringify({ commit, deployedAt: '2026-11-01T10:00:00.000Z', operationId: null }),
      );
    },
    setRemote(commit, subject = 'Next change') {
      writeFileSync(
        join(stateDir, 'remote.json'),
        JSON.stringify({
          commit,
          subject,
          committedAt: null,
          checkedAt: '2026-11-01T11:00:00.000Z',
        }),
      );
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
