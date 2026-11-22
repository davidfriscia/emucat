import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKnownHosts, verifyHostKey } from '../src/repository-access/known-hosts.js';
import {
  RepositoryAccessError,
  SshRepositoryAccess,
  type RepositoryEndpoint,
} from '../src/repository-access/ssh.js';
import { testServerConnection } from '../src/repository-access/test-connection.js';
import { sha256 } from './zip-builder.js';
import { startSftpServer, type TestSftpServer } from './sftp-server.js';

let server: TestSftpServer;

beforeEach(async () => {
  server = await startSftpServer();
});
afterEach(async () => {
  await server.close();
});

function settings(overrides: Partial<ConstructorParameters<typeof SshRepositoryAccess>[0]> = {}) {
  return {
    privateKeyPath: server.clientKeyPath,
    passphraseFile: undefined,
    knownHostsPath: server.knownHostsPath,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

function endpoint(overrides: Partial<RepositoryEndpoint> = {}): RepositoryEndpoint {
  return {
    repositoryId: '00000000-0000-4000-8000-000000000001',
    host: '127.0.0.1',
    port: server.port,
    username: server.username,
    remoteRoot: server.remoteRoot,
    addressSource: 'repository',
    ...overrides,
  };
}

const STAGING = 'archives/.staging/11111111-1111-4111-8111-111111111111.part';
const FINAL = 'archives/86box/DOS622/22222222-2222-4222-8222-222222222222.zip';

describe('the server’s repository connection', () => {
  it('uploads to staging, verifies, publishes without replacing, downloads and deletes', async () => {
    const access = new SshRepositoryAccess(settings());
    const session = await access.open(endpoint());
    try {
      expect(session.hostKeyFingerprint).toMatch(/^SHA256:/);
      const local = join(server.directory, 'upload.bin');
      const data = Buffer.alloc(300_000, 9);
      await writeFile(local, data);
      expect(await session.upload(local, STAGING)).toBe(data.length);
      const verified = await session.verify(STAGING, data.length, sha256(data));
      expect(verified.sha256).toBe(sha256(data));
      await expect(session.verify(STAGING, data.length, 'a'.repeat(64))).rejects.toMatchObject({
        code: 'hash_mismatch',
      });

      await session.publish(STAGING, FINAL);
      expect(await readFile(join(server.root, FINAL))).toEqual(data);
      await expect(session.publish(STAGING, FINAL)).rejects.toMatchObject({
        code: 'archive_exists',
      });

      expect(await session.stat(FINAL)).toEqual({ sizeBytes: data.length });
      expect(await session.stat('archives/none.zip')).toBeNull();

      const downloaded = join(server.directory, 'download.bin');
      const received = await session.download(FINAL, downloaded);
      expect(received).toEqual({ sizeBytes: data.length, sha256: sha256(data) });
      // Never over an existing local file.
      await expect(session.download(FINAL, downloaded)).rejects.toThrow();

      const reader = await session.openReader(FINAL);
      expect((await reader.read(10, 5)).equals(data.subarray(10, 15))).toBe(true);
      await reader.close();

      await session.delete(STAGING);
      await session.delete(STAGING);
      expect(existsSync(join(server.root, STAGING))).toBe(false);
    } finally {
      session.close();
    }
  });

  it('uploads only to a staging key, and never names anything outside the repository', async () => {
    const session = await new SshRepositoryAccess(settings()).open(endpoint());
    try {
      const local = join(server.directory, 'x.bin');
      await writeFile(local, 'x');
      await expect(session.upload(local, FINAL)).rejects.toBeInstanceOf(RepositoryAccessError);
      await expect(session.stat('../outside')).rejects.toBeInstanceOf(RepositoryAccessError);
      await expect(session.stat('/etc/passwd')).rejects.toBeInstanceOf(RepositoryAccessError);
    } finally {
      session.close();
    }
  });

  it('refuses an unknown host, and a changed host key, before authenticating', async () => {
    const unknown = join(server.directory, 'empty_known_hosts');
    await writeFile(unknown, '');
    await expect(
      new SshRepositoryAccess(settings({ knownHostsPath: unknown })).open(endpoint()),
    ).rejects.toMatchObject({ code: 'host_key_unknown' });

    const other = utils.generateKeyPairSync('ed25519').public.split(' ');
    const changed = join(server.directory, 'changed_known_hosts');
    await writeFile(changed, `[127.0.0.1]:${server.port} ${other[0]} ${other[1]}\n`);
    await expect(
      new SshRepositoryAccess(settings({ knownHostsPath: changed })).open(endpoint()),
    ).rejects.toMatchObject({ code: 'host_key_changed' });
  });

  it('says when the key is refused', async () => {
    const wrong = join(server.directory, 'wrong_key');
    await writeFile(wrong, utils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
    await expect(
      new SshRepositoryAccess(settings({ privateKeyPath: wrong })).open(endpoint()),
    ).rejects.toMatchObject({ code: 'ssh_authentication_failed' });
  });

  it('says when nothing listens', async () => {
    await expect(
      new SshRepositoryAccess(settings()).open(endpoint({ port: 1 })),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/host_key_unknown|repository_unreachable/),
    });
  });

  it('says when its key cannot be read, without naming its path', async () => {
    const error = await new SshRepositoryAccess(
      settings({ privateKeyPath: join(server.directory, 'missing') }),
    )
      .open(endpoint())
      .then(
        () => null,
        (caught: unknown) => caught as RepositoryAccessError,
      );
    expect(error).toMatchObject({ code: 'server_repository_unavailable' });
    expect(String(error?.message)).not.toContain(server.directory);
  });
});

describe('Test Server Connection', () => {
  it('passes every step against a working repository, and leaves nothing behind', async () => {
    await mkdir(join(server.root, 'archives'), { recursive: true });
    const result = await testServerConnection(new SshRepositoryAccess(settings()), endpoint());
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.steps.every((step) => step.ok === true)).toBe(true);
    expect(result.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(existsSync(join(server.root, 'archives/.staging'))).toBe(true);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(server.root, 'archives/.staging'))).toEqual([]);
  });

  it('stops at the host key, and shows the fingerprint presented', async () => {
    const other = utils.generateKeyPairSync('ed25519').public.split(' ');
    const changed = join(server.directory, 'changed_known_hosts');
    await writeFile(changed, `[127.0.0.1]:${server.port} ${other[0]} ${other[1]}\n`);
    const result = await testServerConnection(
      new SshRepositoryAccess(settings({ knownHostsPath: changed })),
      endpoint(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('host_key_changed');
    const step = result.steps.find((item) => item.step === 'host_key');
    expect(step?.ok).toBe(false);
    expect(step?.message).toContain('SHA256:');
    expect(result.steps.find((item) => item.step === 'authentication')?.ok).toBeNull();
  });

  it('stops at the connection when nothing listens', async () => {
    const result = await testServerConnection(
      new SshRepositoryAccess(settings()),
      endpoint({ port: 1 }),
    );
    expect(result.ok).toBe(false);
    expect(result.steps.find((item) => item.step === 'connect')?.ok).toBe(false);
  });

  it('stops at publication when the filesystem has no hard links', async () => {
    server.hardlinks = false;
    const result = await testServerConnection(new SshRepositoryAccess(settings()), endpoint());
    expect(result.ok).toBe(false);
    expect(result.steps.find((item) => item.step === 'publication')?.ok).toBe(false);
  });

  it('says plainly when the server has no key at all', async () => {
    const { NO_REPOSITORY_ACCESS } = await import('../src/repository-access/ssh.js');
    const result = await testServerConnection(NO_REPOSITORY_ACCESS, endpoint());
    expect(result.steps[0]).toMatchObject({ step: 'configuration', ok: false });
    expect(result.error?.code).toBe('server_repository_unavailable');
  });
});

describe('known_hosts', () => {
  it('matches hashed and bracketed names, and tells unknown from changed', () => {
    const key = utils.parseKey(utils.generateKeyPairSync('ed25519').public);
    if (key instanceof Error || Array.isArray(key)) throw new Error('key');
    const blob = key.getPublicSSH();
    const line = `[repo.example]:2222 ssh-ed25519 ${blob.toString('base64')}`;
    const hosts = parseKnownHosts(`${line}\n# comment\n`);
    expect(verifyHostKey(hosts, 'repo.example', 2222, blob)).toBe('trusted');
    expect(verifyHostKey(hosts, 'repo.example', 22, blob)).toBe('unknown');
    const other = utils.parseKey(utils.generateKeyPairSync('ed25519').public);
    if (other instanceof Error || Array.isArray(other)) throw new Error('key');
    expect(verifyHostKey(hosts, 'repo.example', 2222, other.getPublicSSH())).toBe('changed');
    const revoked = parseKnownHosts(`@revoked * ssh-ed25519 ${blob.toString('base64')}\n${line}\n`);
    expect(verifyHostKey(revoked, 'repo.example', 2222, blob)).toBe('revoked');
  });
});
