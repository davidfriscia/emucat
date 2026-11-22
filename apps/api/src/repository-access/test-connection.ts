import { lookup } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import {
  SERVER_CONNECTION_STEPS,
  type ServerConnectionStep,
  type ServerConnectionTest,
} from '@emucat/contracts';
import {
  RepositoryAccessError,
  SshRepositoryAccess,
  type RepositoryAccess,
  type RepositoryEndpoint,
} from './ssh.js';

/**
 * Test Server Connection (decision 0055): the server's own path to a repository, one step at a time, so that an
 * administrator sees exactly where it stops. Each step's message is written here, from what was established; none
 * holds a key, a passphrase or a server filesystem path. Nothing existing in the repository is touched: the probe
 * objects have unique names under `archives/.staging` and are removed again.
 */

const TCP_TIMEOUT_MS = 10_000;

function tcpProbe(address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, TCP_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

const STEP_OK: Record<ServerConnectionStep, string> = {
  configuration: 'The server has a repository key and a known_hosts file.',
  resolve: '',
  connect: '',
  host_key: '',
  authentication: 'The repository server accepted the EmuCat server’s key.',
  root_access: 'The remote root exists and is a directory.',
  write: 'A test object was written under archives/.staging.',
  read: 'The test object was read back unchanged.',
  publication: 'A hard link was made, and a second one over it was refused.',
  cleanup: 'The test objects were removed.',
};

export async function testServerConnection(
  access: RepositoryAccess,
  endpoint: RepositoryEndpoint,
  now: () => Date = () => new Date(),
): Promise<ServerConnectionTest> {
  const results = new Map<ServerConnectionStep, { ok: boolean; message: string }>();
  const pass = (step: ServerConnectionStep, message = STEP_OK[step]) =>
    results.set(step, { ok: true, message });
  let hostKeyFingerprint: string | null = null;
  let freeBytes: number | null = null;
  let failure: { code: string; message: string } | null = null;

  const fail = (step: ServerConnectionStep, code: string, message: string) => {
    results.set(step, { ok: false, message });
    failure = { code, message };
  };
  const firstOpen = (): ServerConnectionStep =>
    SERVER_CONNECTION_STEPS.find((step) => !results.has(step)) ?? 'cleanup';

  run: {
    if (!access.configured) {
      fail(
        'configuration',
        'server_repository_unavailable',
        'This server has no repository SSH key. Set REPOSITORY_SSH_PRIVATE_KEY_PATH and REPOSITORY_SSH_KNOWN_HOSTS_PATH (see the deployment guide).',
      );
      break run;
    }
    pass('configuration');

    let address = endpoint.host;
    if (!isIP(endpoint.host)) {
      try {
        address = (await lookup(endpoint.host)).address;
      } catch (error) {
        fail(
          'resolve',
          'repository_unreachable',
          `${endpoint.host} does not resolve from the server (${(error as { code?: string }).code ?? 'lookup failed'}).`,
        );
        break run;
      }
    }
    pass('resolve', `${endpoint.host} resolves to ${address}.`);

    try {
      await tcpProbe(address, endpoint.port);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'failed';
      fail(
        'connect',
        'repository_unreachable',
        `No TCP connection to ${address}:${endpoint.port} (${code}). Check the address, the port, the firewall and the container network.`,
      );
      break run;
    }
    pass('connect', `Port ${endpoint.port} on ${address} accepts connections.`);

    let session;
    try {
      const open =
        access instanceof SshRepositoryAccess
          ? access.open(endpoint, undefined, {
              hostKey: (fingerprint, verdict) => {
                hostKeyFingerprint = fingerprint;
                if (verdict === 'trusted') {
                  pass('host_key', `The host key ${fingerprint} is in known_hosts.`);
                }
              },
            })
          : access.open(endpoint);
      session = await open;
      hostKeyFingerprint = session.hostKeyFingerprint ?? hostKeyFingerprint;
      if (!results.has('host_key')) pass('host_key', 'The host key is in known_hosts.');
      pass('authentication');
    } catch (error) {
      const problem =
        error instanceof RepositoryAccessError
          ? error
          : new RepositoryAccessError('repository_error', 'The SSH connection failed.');
      const step: ServerConnectionStep =
        problem.code === 'host_key_unknown' || problem.code === 'host_key_changed'
          ? 'host_key'
          : problem.code === 'ssh_authentication_failed'
            ? 'authentication'
            : firstOpen();
      const shown = hostKeyFingerprint
        ? `${problem.message}. The server presented ${hostKeyFingerprint}.`
        : `${problem.message}.`;
      fail(step, problem.code, shown);
      break run;
    }

    try {
      await session.probe((step) => pass(step));
      freeBytes = await session.freeSpace();
    } catch (error) {
      const problem =
        error instanceof RepositoryAccessError
          ? error
          : new RepositoryAccessError('repository_error', 'The repository check failed.');
      fail(firstOpen(), problem.code, `${problem.message}.`);
    } finally {
      session.close();
    }
  }

  const steps = SERVER_CONNECTION_STEPS.map((step) => {
    const result = results.get(step);
    return result
      ? { step, ok: result.ok, message: result.message }
      : { step, ok: null, message: 'Not reached.' };
  });
  return {
    ok: failure === null,
    testedAt: now().toISOString(),
    address: { host: endpoint.host, port: endpoint.port, source: endpoint.addressSource },
    hostKeyFingerprint,
    freeBytes,
    steps,
    error: failure,
  };
}
