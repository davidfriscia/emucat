// Host paths are POSIX paths, whatever platform the tests run on.
import { isAbsolute, join } from 'node:path/posix';
import { readEnvFile } from './envfile.ts';

/** Everything the service needs, from host files only. Nothing here can come from a browser. */
export interface DeployerConfig {
  environment: string;
  branch: string;
  /** Off unless the host configuration says exactly `true`. */
  updatesEnabled: boolean;
  root: string;
  stateDir: string;
  operationsDir: string;
  /** The deployment command, installed root-owned outside the repository. */
  ctlPath: string;
  configPath: string;
  socketPath: string;
  tokenFile: string;
  appEnvFile: string;
  /** Through the web container, as the external proxy would reach it. */
  healthUrl: string;
}

export class DeployerConfigError extends Error {
  override readonly name = 'DeployerConfigError';
}

const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Conservative: what `git check-ref-format --branch` accepts, minus anything unusual. */
const BRANCH = /^(?![-.])(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}$/;

/** The default host configuration file. Every other persistent path derives from EMUCAT_ROOT. */
export const DEFAULT_CONFIG_PATH = '/opt/emucat/config/deploy.env';

/** Path settings of the earlier layout, refused so that a stale file cannot point elsewhere. */
const LEGACY_PATH_KEYS = [
  'EMUCAT_APP_ENV_FILE',
  'EMUCAT_DEPLOYER_TOKEN_FILE',
  'EMUCAT_MEDIA_DIR',
  'EMUCAT_BACKUP_DIR',
];

function absolute(name: string, value: string | undefined, fallback: string): string {
  const path = value && value !== '' ? value : fallback;
  if (!isAbsolute(path)) throw new DeployerConfigError(`${name} must be an absolute path`);
  return path;
}

export function loadDeployerConfig(
  configPath: string,
  read: (path: string) => Map<string, string> = readEnvFile,
): DeployerConfig {
  let values: Map<string, string>;
  try {
    values = read(configPath);
  } catch {
    throw new DeployerConfigError(`Cannot read ${configPath}`);
  }
  const environment = values.get('EMUCAT_ENVIRONMENT') ?? '';
  if (!ENVIRONMENT.test(environment)) {
    throw new DeployerConfigError('EMUCAT_ENVIRONMENT must be a short lowercase name');
  }
  const branch = values.get('EMUCAT_BRANCH') ?? '';
  if (!BRANCH.test(branch)) throw new DeployerConfigError('EMUCAT_BRANCH is not a valid branch');
  for (const key of LEGACY_PATH_KEYS) {
    if (values.has(key)) {
      throw new DeployerConfigError(`${key} is no longer supported: paths derive from EMUCAT_ROOT`);
    }
  }
  const root = absolute('EMUCAT_ROOT', values.get('EMUCAT_ROOT'), '/opt/emucat').replace(
    /\/+$/,
    '',
  );
  if (root === '') throw new DeployerConfigError('EMUCAT_ROOT must not be /');
  const configDir = join(root, 'config');
  if (configPath !== join(configDir, 'deploy.env')) {
    throw new DeployerConfigError(`${configPath} must be ${join(configDir, 'deploy.env')}`);
  }
  const stateDir = join(root, 'state');
  const port = values.get('EMUCAT_HTTP_PORT') || '8080';
  if (!/^\d{1,5}$/.test(port)) throw new DeployerConfigError('EMUCAT_HTTP_PORT is not a port');
  const bind = values.get('EMUCAT_BIND_ADDRESS') || '127.0.0.1';
  if (!/^[0-9a-fA-F.:]+$/.test(bind)) {
    throw new DeployerConfigError('EMUCAT_BIND_ADDRESS must be an IP address');
  }
  // Binding to every interface still answers on loopback.
  const healthHost = bind === '0.0.0.0' ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;
  return {
    environment,
    branch,
    updatesEnabled: values.get('EMUCAT_ADMIN_UPDATES_ENABLED') === 'true',
    root,
    stateDir,
    operationsDir: join(stateDir, 'operations'),
    ctlPath: absolute('EMUCAT_CTL', values.get('EMUCAT_CTL'), join(root, 'tooling/bin/emucatctl')),
    configPath,
    socketPath: join(
      absolute('EMUCAT_SOCKET_DIR', values.get('EMUCAT_SOCKET_DIR'), '/run/emucat-deployer'),
      'deployer.sock',
    ),
    tokenFile: join(configDir, 'deployer.token'),
    appEnvFile: join(configDir, 'app.env'),
    healthUrl: `http://${healthHost}:${port}/api/v1/ready`,
  };
}
