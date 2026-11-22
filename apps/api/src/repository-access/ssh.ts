import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isRepositoryKey, isStagingKey } from '@emucat/contracts';
import { Client, type ConnectConfig, type OpenMode, type SFTPWrapper } from 'ssh2';
import {
  fingerprintOf,
  hostKeyAlgorithmsFor,
  parseKnownHosts,
  verifyHostKey,
  type HostKeyVerdict,
} from './known-hosts.js';

/**
 * The EmuCat server's own SSH/SFTP connection to a repository (decision 0055). It mirrors the agent's provider
 * (decision 0013): host keys are always verified against a known_hosts file and never added; only SFTP is used, so
 * an `internal-sftp` account in a chroot is enough; a final key is only ever written by a hard link
 * (`hardlink@openssh.com`), which fails rather than replace anything; stored bytes are read back and hashed rather
 * than trusted.
 *
 * The private key is read from its file whenever a connection is opened. It is never kept, logged, returned or
 * stored in the database, and no error message includes it, its passphrase or its path.
 */

export interface RepositoryAccessSettings {
  privateKeyPath: string;
  passphraseFile: string | undefined;
  knownHostsPath: string;
  connectTimeoutMs: number;
  /** How long one SFTP request may take. A transfer that stops making progress ends here. */
  requestTimeoutMs: number;
}

/** Where and as whom to connect. Built from a repository record only, never from a request. */
export interface RepositoryEndpoint {
  repositoryId: string;
  host: string;
  port: number;
  username: string;
  remoteRoot: string;
  /** Whether `host` is the repository's server-side address or the agents' one. */
  addressSource: 'server' | 'repository';
}

/** The same codes as the agent's `RepositoryErrorKind`, and so as `REGISTRATION_ERROR_CODES`. */
export type RepositoryErrorCode =
  | 'server_repository_unavailable'
  | 'repository_unreachable'
  | 'ssh_authentication_failed'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'repository_permission_denied'
  | 'insufficient_remote_space'
  | 'upload_interrupted'
  | 'remote_object_missing'
  | 'archive_exists'
  | 'publication_unsupported'
  | 'hash_mismatch'
  | 'cancelled'
  | 'repository_error';

export class RepositoryAccessError extends Error {
  override readonly name = 'RepositoryAccessError';

  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }

  /** Whether trying again could help. A refused key, a changed host key or a full disk will not fix themselves. */
  get retryable(): boolean {
    return (
      this.code === 'repository_unreachable' ||
      this.code === 'upload_interrupted' ||
      this.code === 'hash_mismatch'
    );
  }
}

const READ_CHUNK = 64 * 1024;
/** Requests in flight at once. With the chunk size, this is the most memory one stream needs: 1 MiB. */
const WINDOW = 16;

/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_FAILURE = 4;

function sftpCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function mapSftpError(error: unknown, what: string): RepositoryAccessError {
  if (error instanceof RepositoryAccessError) return error;
  switch (sftpCode(error)) {
    case SFTP_NO_SUCH_FILE:
      return new RepositoryAccessError('remote_object_missing', `${what}: no such object`);
    case SFTP_PERMISSION_DENIED:
      return new RepositoryAccessError(
        'repository_permission_denied',
        `${what}: the SSH account is not allowed to do this`,
      );
    default:
      return new RepositoryAccessError('repository_error', `${what}: the server refused`);
  }
}

/** Errors before an SFTP session exists: the network, the host key, or authentication. */
function mapConnectError(error: unknown, verdict: HostKeyVerdict | null): RepositoryAccessError {
  if (verdict === 'unknown') {
    return new RepositoryAccessError(
      'host_key_unknown',
      'The repository server’s host key is not in the server’s known_hosts file. Check it out of band, then add it',
    );
  }
  if (verdict === 'changed' || verdict === 'revoked') {
    return new RepositoryAccessError(
      'host_key_changed',
      'The repository server’s host key differs from the one in the server’s known_hosts file. Refusing to connect: this can mean an attack, or a reinstalled server',
    );
  }
  const level = (error as { level?: string }).level;
  if (level === 'client-authentication') {
    return new RepositoryAccessError(
      'ssh_authentication_failed',
      'The repository server refused the EmuCat server’s key. Install its public key in the SSH account’s authorized_keys',
    );
  }
  if (level === 'client-timeout') {
    return new RepositoryAccessError(
      'repository_unreachable',
      'Timed out connecting to the repository server',
    );
  }
  const code = (error as { code?: string }).code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  ) {
    return new RepositoryAccessError(
      'repository_unreachable',
      `Cannot reach the repository server (${code})`,
    );
  }
  return new RepositoryAccessError(
    'repository_unreachable',
    'The SSH connection to the repository failed',
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(
            new RepositoryAccessError(
              'upload_interrupted',
              'The repository server stopped answering',
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type Progress = (doneBytes: number, totalBytes: number) => void;

export interface VerifiedObject {
  sizeBytes: number;
  sha256: string;
}

/** Random access to one stored object, for reading an archive's structure without downloading it. */
export interface ObjectReader {
  readonly sizeBytes: number;
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface HealthResult {
  hostKeyFingerprint: string | null;
  freeBytes: number | null;
}

/** One open connection. Callers close it; it also closes if the server goes away. */
export interface RepositorySession {
  readonly endpoint: RepositoryEndpoint;
  readonly hostKeyFingerprint: string | null;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Writes a local file to a staging key, replacing an earlier attempt at that key. Refuses any other key. */
  upload(
    localPath: string,
    key: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<number>;
  /** Writes an object to a new local file (never an existing one), and says what was received. */
  download(
    key: string,
    localPath: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<VerifiedObject>;
  /** Reads the stored bytes back and compares them with what is expected. */
  verify(
    key: string,
    sizeBytes: number,
    sha256: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<VerifiedObject>;
  /** Makes a staging object visible at its final key, failing with `archive_exists` rather than replacing. */
  publish(stagingKey: string, finalKey: string): Promise<void>;
  /** Removes an object. One that does not exist is not an error. */
  delete(key: string): Promise<void>;
  freeSpace(): Promise<number | null>;
  openReader(key: string): Promise<ObjectReader>;
  /** Proves read, write and no-overwrite publication with objects of its own, which it removes again. */
  probe(
    onStep?: (step: 'root_access' | 'write' | 'read' | 'publication' | 'cleanup') => void,
  ): Promise<void>;
  close(): void;
}

/** What the rest of the server sees: whether a connection is possible at all, and opening one. */
export interface RepositoryAccess {
  readonly configured: boolean;
  open(endpoint: RepositoryEndpoint, signal?: AbortSignal): Promise<RepositorySession>;
}

/** A server with no key: every attempt says so, the same way. */
export const NO_REPOSITORY_ACCESS: RepositoryAccess = {
  configured: false,
  open: () =>
    Promise.reject(
      new RepositoryAccessError(
        'server_repository_unavailable',
        'This server has no SSH key for repositories (REPOSITORY_SSH_PRIVATE_KEY_PATH)',
      ),
    ),
};

export interface ConnectionStages {
  resolved?: (address: string) => void;
  connected?: () => void;
  hostKey?: (fingerprint: string, verdict: HostKeyVerdict) => void;
}

export class SshRepositoryAccess implements RepositoryAccess {
  readonly configured = true;

  constructor(private readonly settings: RepositoryAccessSettings) {}

  private async credentials(): Promise<{ privateKey: Buffer; passphrase?: string }> {
    let privateKey: Buffer;
    try {
      privateKey = await readFile(this.settings.privateKeyPath);
    } catch {
      throw new RepositoryAccessError(
        'server_repository_unavailable',
        'The server’s repository SSH key cannot be read. Check REPOSITORY_SSH_PRIVATE_KEY_PATH and the file’s owner',
      );
    }
    if (!this.settings.passphraseFile) return { privateKey };
    try {
      const passphrase = (await readFile(this.settings.passphraseFile, 'utf8')).replace(
        /\r?\n$/,
        '',
      );
      return { privateKey, passphrase };
    } catch {
      throw new RepositoryAccessError(
        'server_repository_unavailable',
        'The passphrase file of the server’s repository SSH key cannot be read',
      );
    }
  }

  private async knownHosts() {
    try {
      return parseKnownHosts(await readFile(this.settings.knownHostsPath, 'utf8'));
    } catch {
      throw new RepositoryAccessError(
        'server_repository_unavailable',
        'The server’s known_hosts file for repositories cannot be read. Check REPOSITORY_SSH_KNOWN_HOSTS_PATH',
      );
    }
  }

  async open(
    endpoint: RepositoryEndpoint,
    signal?: AbortSignal,
    stages: ConnectionStages = {},
  ): Promise<RepositorySession> {
    const [knownHosts, credentials] = await Promise.all([this.knownHosts(), this.credentials()]);
    const algorithms = hostKeyAlgorithmsFor(knownHosts, endpoint.host, endpoint.port);
    if (algorithms.length === 0) {
      throw new RepositoryAccessError(
        'host_key_unknown',
        `The server’s known_hosts file has no key for ${endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`}. Add the repository server’s verified host key`,
      );
    }

    let address = endpoint.host;
    if (!isIP(endpoint.host)) {
      try {
        address = (await lookup(endpoint.host)).address;
      } catch (error) {
        throw new RepositoryAccessError(
          'repository_unreachable',
          `Cannot resolve ${endpoint.host} (${(error as { code?: string }).code ?? 'lookup failed'})`,
        );
      }
    }
    stages.resolved?.(address);

    const client = new Client();
    let verdict: HostKeyVerdict | null = null;
    let fingerprint: string | null = null;
    const config: ConnectConfig = {
      host: address,
      port: endpoint.port,
      username: endpoint.username,
      privateKey: credentials.privateKey,
      ...(credentials.passphrase !== undefined ? { passphrase: credentials.passphrase } : {}),
      readyTimeout: this.settings.connectTimeoutMs,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Agent forwarding, keyboard-interactive and passwords are never offered: only this key.
      tryKeyboard: false,
      algorithms: { serverHostKey: algorithms as never },
      // Judged against the name in the repository record, not the resolved address.
      hostVerifier: (key: Buffer) => {
        fingerprint = fingerprintOf(key);
        verdict = verifyHostKey(knownHosts, endpoint.host, endpoint.port, key);
        stages.hostKey?.(fingerprint, verdict);
        return verdict === 'trusted';
      },
    };
    client.on('handshake', () => stages.connected?.());

    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (error) => reject(mapConnectError(error, verdict)));
      client.once('close', () =>
        reject(
          verdict !== null && verdict !== 'trusted'
            ? mapConnectError(new Error('closed'), verdict)
            : new RepositoryAccessError('repository_unreachable', 'The SSH connection closed'),
        ),
      );
    });
    const abort = () => client.end();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      client.connect(config);
      await ready;
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, wrapper) =>
          error
            ? reject(
                new RepositoryAccessError(
                  'repository_error',
                  'The repository server has no SFTP subsystem for this account',
                ),
              )
            : resolve(wrapper),
        );
      });
      // Every later error is a request's: the connection's own errors end it, and are noticed there.
      client.on('error', () => undefined);
      return new SshSession(client, sftp, endpoint, fingerprint, this.settings.requestTimeoutMs);
    } catch (error) {
      client.end();
      if (signal?.aborted) throw new RepositoryAccessError('cancelled', 'Cancelled');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}

const HEALTH_CONTENT = Buffer.from('emucat server repository health check\n');

class SshSession implements RepositorySession {
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    readonly endpoint: RepositoryEndpoint,
    readonly hostKeyFingerprint: string | null,
    private readonly requestTimeoutMs: number,
  ) {
    client.once('close', () => {
      this.closed = true;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.end();
  }

  private path(key: string): string {
    if (!isRepositoryKey(key)) {
      throw new RepositoryAccessError('repository_error', 'Not a valid repository key');
    }
    return `${this.endpoint.remoteRoot.replace(/\/+$/, '')}/${key}`;
  }

  /** One SFTP request, bounded in time. A server that stops answering ends the connection. */
  private request<T>(what: string, start: (done: (error: unknown, value?: T) => void) => void) {
    if (this.closed) {
      return Promise.reject(
        new RepositoryAccessError('upload_interrupted', 'The SSH connection closed'),
      );
    }
    const promise = new Promise<T>((resolve, reject) => {
      try {
        start((error, value) => (error ? reject(error) : resolve(value as T)));
      } catch (error) {
        reject(error);
      }
    });
    return withTimeout(promise, this.requestTimeoutMs, () => this.close()).catch((error) => {
      if (error instanceof RepositoryAccessError) throw error;
      if (this.closed && sftpCode(error) === undefined) {
        throw new RepositoryAccessError('upload_interrupted', `${what}: the SSH connection closed`);
      }
      throw error;
    });
  }

  private openHandle(path: string, flags: OpenMode, what: string): Promise<Buffer> {
    return this.request<Buffer>(what, (done) => this.sftp.open(path, flags, done));
  }

  private closeHandle(handle: Buffer): Promise<void> {
    return this.request<void>('Closing', (done) => this.sftp.close(handle, done)).catch(
      () => undefined,
    );
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stats = await this.request<{ size: number; isFile(): boolean }>('Checking', (done) =>
        this.sftp.stat(this.path(key), done),
      );
      return { sizeBytes: Number(stats.size) };
    } catch (error) {
      if (sftpCode(error) === SFTP_NO_SUCH_FILE) return null;
      throw mapSftpError(error, 'Cannot check the object');
    }
  }

  /** Every directory above a key, created if missing. Concurrent creators are fine: an existing one is checked. */
  private async ensureParents(key: string): Promise<void> {
    const segments = key.split('/').slice(0, -1);
    let current = this.endpoint.remoteRoot.replace(/\/+$/, '');
    for (const segment of segments) {
      current = `${current}/${segment}`;
      const directory = current;
      try {
        await this.request<void>('Creating a directory', (done) =>
          this.sftp.mkdir(directory, done),
        );
      } catch (error) {
        const exists = await this.request<{ isDirectory(): boolean }>('Checking', (done) =>
          this.sftp.stat(directory, done),
        ).catch(() => null);
        if (!exists?.isDirectory()) throw mapSftpError(error, 'Cannot create a directory');
      }
    }
  }

  async upload(
    localPath: string,
    key: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!isStagingKey(key)) {
      throw new RepositoryAccessError('repository_error', 'Uploads go to a staging key only');
    }
    await this.ensureParents(key);
    const remote = this.path(key);
    const local = await open(localPath, 'r');
    try {
      const size = (await local.stat()).size;
      let handle: Buffer;
      try {
        // Truncating: an earlier attempt at this staging key is replaced, as the agent's provider does.
        handle = await this.openHandle(remote, 'w', 'Cannot write to the repository');
      } catch (error) {
        throw mapSftpError(error, 'Cannot write to the repository');
      }
      try {
        let offset = 0;
        const inFlight = new Set<Promise<void>>();
        let failure: unknown = null;
        while (offset < size && failure === null) {
          if (signal?.aborted) throw new RepositoryAccessError('cancelled', 'Cancelled');
          const length = Math.min(READ_CHUNK, size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await local.read(buffer, 0, length, offset);
          if (bytesRead !== length) {
            throw new RepositoryAccessError('upload_interrupted', 'The local file changed size');
          }
          const position = offset;
          const write = this.request<void>('Writing', (done) =>
            this.sftp.write(handle, buffer, 0, length, position, done),
          ).then(
            () => {
              inFlight.delete(write);
            },
            (error: unknown) => {
              inFlight.delete(write);
              failure ??= error;
            },
          );
          inFlight.add(write);
          offset += length;
          progress?.(offset, size);
          if (inFlight.size >= WINDOW) await Promise.race(inFlight);
        }
        await Promise.all(inFlight);
        if (failure !== null) {
          // OpenSSH reports a full disk or quota as a generic failure.
          if (sftpCode(failure) === SFTP_FAILURE) {
            throw new RepositoryAccessError(
              'insufficient_remote_space',
              'The repository server could not store the data. Its disk or quota is probably full',
            );
          }
          throw mapSftpError(failure, 'The upload failed');
        }
        await this.fsync(handle);
      } finally {
        await this.closeHandle(handle);
      }
      return size;
    } finally {
      await local.close();
    }
  }

  private async fsync(handle: Buffer): Promise<void> {
    try {
      await this.request<void>('Flushing', (done) => this.sftp.ext_openssh_fsync(handle, done));
    } catch (error) {
      // Not offered by every server. The bytes are verified by reading them back anyway.
      if (error instanceof RepositoryAccessError) throw error;
    }
  }

  /** Reads `[start, end)` in order, with a window of requests in flight, handing each piece to `sink` in order. */
  private async stream(
    handle: Buffer,
    start: number,
    end: number,
    sink: (piece: Buffer) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<number> {
    const pending: Promise<Buffer>[] = [];
    let next = start;
    let done = start;
    const issue = () => {
      const position = next;
      const length = Math.min(READ_CHUNK, end - position);
      next += length;
      pending.push(
        this.request<Buffer>('Reading', (finish) => {
          const buffer = Buffer.allocUnsafe(length);
          this.sftp.read(handle, buffer, 0, length, position, (error, bytesRead) =>
            finish(error, buffer.subarray(0, bytesRead)),
          );
        }),
      );
    };
    while (next < end && pending.length < WINDOW) issue();
    while (pending.length > 0) {
      if (signal?.aborted) throw new RepositoryAccessError('cancelled', 'Cancelled');
      const piece = await (pending.shift() as Promise<Buffer>);
      if (piece.length === 0) {
        throw new RepositoryAccessError('upload_interrupted', 'The object ended early');
      }
      await sink(piece);
      done += piece.length;
      // A short read: ask for the rest, in order, before anything later is used.
      const expected = Math.min(READ_CHUNK, end - (done - piece.length));
      if (piece.length < expected) {
        await Promise.allSettled(pending.splice(0));
        next = done;
      }
      while (next < end && pending.length < WINDOW) issue();
    }
    return done - start;
  }

  private async readAll(
    key: string,
    sink: (piece: Buffer) => Promise<void> | void,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<number> {
    const remote = this.path(key);
    let handle: Buffer;
    let size: number;
    try {
      handle = await this.openHandle(remote, 'r', 'Cannot read from the repository');
      const stats = await this.request<{ size: number }>('Checking', (done) =>
        this.sftp.fstat(handle, done),
      );
      size = Number(stats.size);
    } catch (error) {
      throw mapSftpError(error, 'Cannot read from the repository');
    }
    try {
      let read = 0;
      await this.stream(
        handle,
        0,
        size,
        async (piece) => {
          await sink(piece);
          read += piece.length;
          progress?.(read, size);
        },
        signal,
      );
      return read;
    } catch (error) {
      throw mapSftpError(error, 'Cannot read from the repository');
    } finally {
      await this.closeHandle(handle);
    }
  }

  async download(
    key: string,
    localPath: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<VerifiedObject> {
    // `wx`: never over an existing file, so a staging path cannot be pointed at something else.
    const file: FileHandle = await open(localPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let position = 0;
    try {
      const size = await this.readAll(
        key,
        async (piece) => {
          hash.update(piece);
          await file.write(piece, 0, piece.length, position);
          position += piece.length;
        },
        progress,
        signal,
      );
      await file.sync();
      return { sizeBytes: size, sha256: hash.digest('hex') };
    } finally {
      await file.close();
    }
  }

  async verify(
    key: string,
    sizeBytes: number,
    sha256: string,
    progress?: Progress,
    signal?: AbortSignal,
  ): Promise<VerifiedObject> {
    const stats = await this.stat(key);
    if (!stats) throw new RepositoryAccessError('remote_object_missing', 'The object is missing');
    if (stats.sizeBytes !== sizeBytes) {
      throw new RepositoryAccessError(
        'hash_mismatch',
        `The stored object has ${stats.sizeBytes} bytes, and ${sizeBytes} were expected`,
      );
    }
    const hash = createHash('sha256');
    const read = await this.readAll(key, (piece) => void hash.update(piece), progress, signal);
    const actual = hash.digest('hex');
    if (read !== sizeBytes || actual !== sha256) {
      throw new RepositoryAccessError(
        'hash_mismatch',
        'The stored object differs from what was expected',
      );
    }
    return { sizeBytes: read, sha256: actual };
  }

  async publish(stagingKey: string, finalKey: string): Promise<void> {
    if (!isStagingKey(stagingKey) || isStagingKey(finalKey)) {
      throw new RepositoryAccessError('repository_error', 'Publication goes from staging to final');
    }
    await this.ensureParents(finalKey);
    const from = this.path(stagingKey);
    const to = this.path(finalKey);
    try {
      await this.request<void>('Publishing', (done) =>
        this.sftp.ext_openssh_hardlink(from, to, done),
      );
    } catch (error) {
      if (error instanceof RepositoryAccessError) throw error;
      if (/does not support/i.test(String((error as Error).message))) {
        throw new RepositoryAccessError(
          'publication_unsupported',
          'This repository server has no hardlink@openssh.com extension',
        );
      }
      if ((await this.stat(finalKey)) !== null) {
        throw new RepositoryAccessError('archive_exists', 'An object already has this key');
      }
      throw mapSftpError(error, 'Cannot publish the object');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.request<void>('Deleting', (done) => this.sftp.unlink(this.path(key), done));
    } catch (error) {
      if (sftpCode(error) === SFTP_NO_SUCH_FILE) return;
      throw mapSftpError(error, 'Cannot delete the object');
    }
  }

  async freeSpace(): Promise<number | null> {
    try {
      const info = await this.request<{ bavail: number; frsize: number }>(
        'Checking space',
        (done) => this.sftp.ext_openssh_statvfs(this.endpoint.remoteRoot, done),
      );
      return Number(info.bavail) * Number(info.frsize);
    } catch {
      return null;
    }
  }

  async openReader(key: string): Promise<ObjectReader> {
    let handle: Buffer;
    let size: number;
    try {
      handle = await this.openHandle(this.path(key), 'r', 'Cannot read from the repository');
      const stats = await this.request<{ size: number }>('Checking', (done) =>
        this.sftp.fstat(handle, done),
      );
      size = Number(stats.size);
    } catch (error) {
      throw mapSftpError(error, 'Cannot read from the repository');
    }
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const end = Math.min(size, offset + length);
      if (offset < 0 || offset > end) {
        throw new RepositoryAccessError('repository_error', 'A read outside the object');
      }
      const pieces: Buffer[] = [];
      await this.stream(handle, offset, end, (piece) => void pieces.push(Buffer.from(piece)));
      return Buffer.concat(pieces);
    };
    return { sizeBytes: size, read, close: () => this.closeHandle(handle) };
  }

  async probe(
    onStep?: (step: 'root_access' | 'write' | 'read' | 'publication' | 'cleanup') => void,
  ): Promise<void> {
    const root = this.endpoint.remoteRoot;
    try {
      const stats = await this.request<{ isDirectory(): boolean }>('Checking', (done) =>
        this.sftp.stat(root, done),
      );
      if (!stats.isDirectory()) {
        throw new RepositoryAccessError('repository_error', 'The remote root is not a directory');
      }
    } catch (error) {
      throw mapSftpError(error, 'Cannot open the remote root');
    }
    onStep?.('root_access');

    const id = randomUUID();
    const probe = `archives/.staging/.server-health-${id}.part`;
    const link = `archives/.staging/.server-health-${id}.link`;
    let cleaned: boolean;
    try {
      await this.ensureParents(probe);
      let handle: Buffer;
      try {
        // Exclusive: the name is unique, and this could never touch anything that exists.
        handle = await this.openHandle(this.path(probe), 'wx', 'Cannot write');
        await this.request<void>('Writing', (done) =>
          this.sftp.write(handle, HEALTH_CONTENT, 0, HEALTH_CONTENT.length, 0, done),
        );
        await this.closeHandle(handle);
      } catch (error) {
        throw mapSftpError(error, 'Cannot write to the repository');
      }
      onStep?.('write');

      const reader = await this.openReader(probe);
      const back = await reader.read(0, HEALTH_CONTENT.length + 1);
      await reader.close();
      if (!back.equals(HEALTH_CONTENT)) {
        throw new RepositoryAccessError(
          'hash_mismatch',
          'The repository returned different bytes than were written',
        );
      }
      onStep?.('read');

      try {
        await this.request<void>('Linking', (done) =>
          this.sftp.ext_openssh_hardlink(this.path(probe), this.path(link), done),
        );
      } catch (error) {
        if (sftpCode(error) === SFTP_PERMISSION_DENIED) {
          throw mapSftpError(error, 'Cannot make a hard link');
        }
        throw new RepositoryAccessError(
          'publication_unsupported',
          'Hard links do not work on the repository’s filesystem, or hardlink@openssh.com is missing',
        );
      }
      const second = await this.request<void>('Linking', (done) =>
        this.sftp.ext_openssh_hardlink(this.path(probe), this.path(link), done),
      ).then(
        () => true,
        () => false,
      );
      if (second) {
        throw new RepositoryAccessError(
          'publication_unsupported',
          'The repository server replaced an existing object when linking over it',
        );
      }
      onStep?.('publication');
    } finally {
      const removed = await Promise.all([
        this.delete(link).then(
          () => true,
          () => false,
        ),
        this.delete(probe).then(
          () => true,
          () => false,
        ),
      ]);
      cleaned = removed.every(Boolean);
    }
    if (!cleaned) {
      throw new RepositoryAccessError(
        'repository_permission_denied',
        'The test objects under archives/.staging could not be removed. Check that the SSH account may delete files there',
      );
    }
    onStep?.('cleanup');
  }
}
