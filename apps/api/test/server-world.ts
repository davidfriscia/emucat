/**
 * A version world whose server has its own repository connection (decision 0055): a real SSH/SFTP server in
 * process, the repository record pointing at it through its server-side address, and real archives in it.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { archiveObjectKey, type EmulatorType, type RepositorySummary } from '@emucat/contracts';
import { expect } from 'vitest';
import type { BrowserDependencies } from '../src/routes/browser.js';
import { SshRepositoryAccess } from '../src/repository-access/ssh.js';
import { DEFAULT_TRANSFER_POLICY, type TransferPolicy } from '../src/transfers/policy.js';
import { startSftpServer, type TestSftpServer } from './sftp-server.js';
import { world, type Capabilities, type World } from './version-world.js';
import { sha256 } from './zip-builder.js';

export interface ServerWorld extends World {
  sftp: TestSftpServer;
  access: SshRepositoryAccess;
  /** Writes an object into the repository, as an agent would have published it. */
  put(key: string, data: Buffer): Promise<void>;
  /** Registers a version whose archive is these bytes, and puts them at its key. Rows are immutable. */
  insertVersion(
    data: Buffer,
    options?: {
      vm?: { emulatorType: EmulatorType; vmName: string };
      kind?: 'master' | 'snapshot';
      parentVersionId?: string;
      snapshotName?: string;
      title?: string | null;
    },
  ): Promise<{ id: string; key: string }>;
}

const servers: TestSftpServer[] = [];

export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

export function accessFor(sftp: TestSftpServer): SshRepositoryAccess {
  return new SshRepositoryAccess({
    privateKeyPath: sftp.clientKeyPath,
    passphraseFile: undefined,
    knownHostsPath: sftp.knownHostsPath,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });
}

export async function serverWorld(
  options: {
    capabilities?: Capabilities;
    transfers?: Partial<TransferPolicy>;
    overrides?: Partial<BrowserDependencies>;
  } = {},
): Promise<ServerWorld> {
  const sftp = await startSftpServer();
  servers.push(sftp);
  const access = accessFor(sftp);
  const base = await world(
    options.capabilities,
    {},
    {
      repositoryAccess: access,
      ...(options.transfers
        ? {
            transfers: {
              ...DEFAULT_TRANSFER_POLICY,
              stagingPath: join(sftp.directory, 'staging'),
              ...options.transfers,
            },
          }
        : {}),
      ...options.overrides,
    },
  );
  // The agents' address stays what it was; the server uses its own.
  const updated = await base.admin.request({
    method: 'PUT',
    url: `/admin/repositories/${base.repository.id}`,
    payload: {
      name: 'NAS',
      host: 'nas.example',
      port: 22,
      username: sftp.username,
      remoteRoot: sftp.remoteRoot,
      serverHost: '127.0.0.1',
      serverPort: sftp.port,
    },
  });
  expect(updated.statusCode, updated.body).toBe(200);
  const repository = updated.json<RepositorySummary>();
  const put = async (key: string, data: Buffer) => {
    const path = join(sftp.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  const insertVersion: ServerWorld['insertVersion'] = async (data, options = {}) => {
    const vm = options.vm ?? { emulatorType: 'qemu', vmName: 'Win98' };
    const id = randomUUID();
    const key = archiveObjectKey(vm, id);
    await put(key, data);
    await base.context.pool.execute(
      `INSERT INTO vm_versions
         (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name, title, repository_id, archive_key,
          archive_sha256, archive_size_bytes, created_by_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        vm.emulatorType,
        vm.vmName,
        options.kind ?? 'master',
        options.parentVersionId ?? null,
        options.snapshotName ?? null,
        options.title ?? null,
        repository.id,
        key,
        sha256(data),
        data.length,
        base.paired.agentId,
      ],
    );
    return { id, key };
  };
  return { ...base, repository, sftp, access, put, insertVersion };
}
