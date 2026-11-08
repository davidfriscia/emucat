import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployerConfig } from './config.ts';
import { ServiceError, type CheckResult, type HostRunner } from './service.ts';

/** A minimal, fixed environment: nothing from this service's own environment is passed on. */
function commandEnvironment(config: DeployerConfig): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    // The deployment account's home inside the layout (Docker and Git keep their client files there).
    HOME: join(config.stateDir, 'home'),
    EMUCAT_DEPLOY_CONFIG: config.configPath,
  };
}

/** Runs the installed `emucatctl` with fixed arguments. Never through a shell. */
export function hostRunner(config: DeployerConfig): HostRunner {
  const env = commandEnvironment(config);
  return {
    startUpdate(operationId, expectedCommit, requestedBy) {
      const log = openSync(join(config.operationsDir, `${operationId}.log`), 'a', 0o640);
      try {
        const child = spawn(
          config.ctlPath,
          [
            'update',
            '--operation',
            operationId,
            '--expect',
            expectedCommit,
            '--requested-by',
            requestedBy,
          ],
          // Detached: the update must outlive a restart of this service.
          { detached: true, stdio: ['ignore', log, log], env, shell: false },
        );
        if (child.pid === undefined) throw new Error('spawn failed');
        child.unref();
        return child.pid;
      } finally {
        closeSync(log);
      }
    },

    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },

    lockHeld() {
      return new Promise((resolve) => {
        execFile(
          'flock',
          ['--nonblock', '--shared', join(config.stateDir, 'deploy.lock'), 'true'],
          { env, timeout: 5_000 },
          (error) => resolve(error !== null),
        );
      });
    },

    checkUpdate() {
      return new Promise<CheckResult>((resolve, reject) => {
        execFile(
          config.ctlPath,
          ['check-update', '--json'],
          { env, timeout: 110_000, maxBuffer: 64 * 1024, shell: false },
          (error, stdout) => {
            if (error) {
              const code = (error as { code?: unknown }).code;
              return reject(
                code === 75
                  ? new ServiceError(409, 'update_in_progress', 'An update is in progress')
                  : new ServiceError(
                      502,
                      'check_failed',
                      'The repository could not be checked. See the deployment service log.',
                    ),
              );
            }
            try {
              resolve(JSON.parse(stdout) as CheckResult);
            } catch {
              reject(new ServiceError(502, 'check_failed', 'The repository check gave no result'));
            }
          },
        );
      });
    },

    async healthy() {
      const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: unknown };
      return body.status === 'ready';
    },
  };
}
