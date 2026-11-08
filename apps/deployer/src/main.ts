import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { DeployerConfigError, loadDeployerConfig } from './config.ts';
import { readEnvFile } from './envfile.ts';
import { createControlServer } from './http.ts';
import { hostRunner } from './runner.ts';
import { createSanitizer, secretValues } from './sanitize.ts';
import { DeploymentService } from './service.ts';

/**
 * The EmuCat deployment service. Runs on the host under systemd as the deployment account, listens on a
 * Unix socket only, and is the only component that runs `emucatctl` on behalf of the browser.
 */

const RECONCILE_INTERVAL_MS = 2_000;

function log(message: string): void {
  // systemd's journal adds the timestamp.
  console.log(message);
}

function main(): void {
  const configPath = process.env.EMUCAT_DEPLOY_CONFIG ?? '/etc/emucat/deploy.env';
  const config = loadDeployerConfig(configPath);
  const token = () => readFileSync(config.tokenFile, 'utf8').trim();
  if (token().length < 32) throw new DeployerConfigError('The deployer token is too short');

  let appSecrets: string[] = [];
  try {
    appSecrets = secretValues(readEnvFile(config.appEnvFile));
  } catch {
    log(
      'Warning: cannot read the application environment file; logs are sanitized by pattern only',
    );
  }
  const sanitize = createSanitizer([...appSecrets, token()]);

  const service = new DeploymentService({ config, runner: hostRunner(config), sanitize });

  const server = createControlServer(service, token, log);

  // A socket left by a previous run. Only ever a socket: never remove anything else.
  try {
    if (lstatSync(config.socketPath).isSocket()) unlinkSync(config.socketPath);
  } catch {
    // Not there.
  }
  server.listen(config.socketPath, () => {
    chmodSync(config.socketPath, 0o660);
    log(
      `EmuCat deployment service listening on ${config.socketPath} ` +
        `(environment ${config.environment}, branch ${config.branch}, ` +
        `browser updates ${config.updatesEnabled ? 'enabled' : 'disabled'})`,
    );
  });

  let reconciling = false;
  const timer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    service
      .reconcile()
      .catch((error: unknown) => log(`Reconcile failed: ${String(error)}`))
      .finally(() => {
        reconciling = false;
      });
  }, RECONCILE_INTERVAL_MS);

  const stop = (signal: string) => {
    // A running update is deliberately left alone: it belongs to its own process and lock, and the next
    // start of this service picks up its result.
    log(`Stopping on ${signal}`);
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
