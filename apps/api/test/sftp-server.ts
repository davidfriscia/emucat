import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Server, utils, type Connection } from 'ssh2';

/**
 * A real SSH server with an SFTP subsystem, in process, over a temporary directory: enough of OpenSSH for the
 * server's repository connection (decision 0055) to be tested end to end, host-key checks and public-key
 * authentication included. It offers `hardlink@openssh.com` and `fsync@openssh.com` as OpenSSH does.
 */

const STATUS = utils.sftp.STATUS_CODE;
const SERVER_VERSION = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);

function versionWithExtensions(names: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from([2, 0, 0, 0, 3])];
  for (const name of names) {
    for (const text of [name, '1']) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(Buffer.byteLength(text));
      parts.push(length, Buffer.from(text));
    }
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function readStrings(data: Buffer, count: number): string[] {
  const values: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const length = data.readUInt32BE(offset);
    values.push(data.subarray(offset + 4, offset + 4 + length).toString('utf8'));
    offset += 4 + length;
  }
  return values;
}

export interface TestSftpServer {
  port: number;
  /** The local directory holding what the repository holds. */
  root: string;
  /** What a repository record names as its remote root. */
  remoteRoot: string;
  username: string;
  /** A known_hosts line for this server, as an administrator would add it. */
  knownHostsLine(host?: string): string;
  hostKeyFingerprintBase64: string;
  /** Files with the client's private key and a known_hosts file, for RepositoryAccessSettings. */
  clientKeyPath: string;
  knownHostsPath: string;
  directory: string;
  /** Turns hard links off, as on a filesystem without them. */
  hardlinks: boolean;
  /** What clients read, for checking that only the needed byte ranges cross the wire. */
  stats: { bytesRead: number; reads: Array<[offset: number, length: number]> };
  resetStats(): void;
  /** Open SFTP file handles and SSH connections right now: both must return to 0. */
  openHandles(): number;
  openConnections(): number;
  /** Delays every READ answer, to test deadlines and cancellation. */
  readDelayMs: number;
  /**
   * Holds every READ answer after the first `after` until the returned function is called, so that a test can act
   * while a client is known to be waiting on the repository, without guessing at timing. Reads are still counted when
   * they arrive; `heldReads()` says how many answers are held now.
   */
  holdReads(after?: number): () => void;
  heldReads(): number;
  close(): Promise<void>;
}

/**
 * ssh2's generator occasionally (about 1 in 300) writes an ed25519 key its own parser then refuses. A test server
 * must not fail because of that, so keys are generated until one parses.
 */
function parseableKeyPair() {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (
      !(utils.parseKey(pair.private) instanceof Error) &&
      !(utils.parseKey(pair.public) instanceof Error)
    ) {
      return pair;
    }
  }
}

export async function startSftpServer(): Promise<TestSftpServer> {
  const directory = await mkdtemp(join(tmpdir(), 'emucat-sftp-'));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const host = parseableKeyPair();
  const client = parseableKeyPair();
  const clientKeyPath = join(directory, 'id_ed25519');
  writeFileSync(clientKeyPath, client.private, { mode: 0o600 });
  const allowed = utils.parseKey(client.public);
  if (allowed instanceof Error) throw allowed;
  const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed;
  const hostPublic = host.public.split(' ');
  const remoteRoot = '/repo';
  const username = 'emucat';
  const connections = new Set<Connection>();

  const localPath = (path: string): string | null => {
    if (path !== remoteRoot && !path.startsWith(`${remoteRoot}/`)) return null;
    const target = resolve(root, `.${path.slice(remoteRoot.length)}`);
    return target === root || target.startsWith(root + sep) ? target : null;
  };

  const state = { hardlinks: true, readDelayMs: 0 };
  let hold: { after: number; seen: number; held: Array<() => void> } | null = null;
  const stats = { bytesRead: 0, reads: [] as Array<[number, number]> };
  let handleCount = 0;
  const server = new Server({ hostKeys: [host.private] }, (connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', () => undefined);
    connection.on('authentication', (context) => {
      if (context.method !== 'publickey' || context.username !== username) {
        context.reject(['publickey']);
        return;
      }
      const offered = context.key.data;
      const expected = allowedKey.getPublicSSH();
      if (
        context.key.algo !== allowedKey.type ||
        offered.length !== expected.length ||
        !timingSafeEqual(offered, expected)
      ) {
        context.reject(['publickey']);
        return;
      }
      if (context.signature && context.blob) {
        if (allowedKey.verify(context.blob, context.signature, context.hashAlgo) !== true) {
          context.reject(['publickey']);
          return;
        }
      }
      context.accept();
    });
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          // ssh2 answers INIT with no extensions; OpenSSH offers these, and the client relies on them.
          const protocol = (
            sftp as unknown as { _protocol: { channelData(id: number, data: Buffer): void } }
          )._protocol;
          const original = protocol.channelData.bind(protocol);
          protocol.channelData = (id, data) => {
            if (data.equals(SERVER_VERSION)) {
              original(id, versionWithExtensions(['hardlink@openssh.com', 'fsync@openssh.com']));
              return;
            }
            original(id, data);
          };
          const handles = new Map<number, number>();
          let next = 0;
          // As OpenSSH does: a session that ends closes whatever its client left open.
          const closeAll = () => {
            for (const fd of handles.values()) {
              closeSync(fd);
              handleCount -= 1;
            }
            handles.clear();
          };
          sftp.once('close', closeAll);
          sftp.once('end', closeAll);
          const handleOf = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));
          const fail = (reqid: number, error: unknown) => {
            const code = (error as NodeJS.ErrnoException).code;
            sftp.status(
              reqid,
              code === 'ENOENT'
                ? STATUS.NO_SUCH_FILE
                : code === 'EACCES' || code === 'EPERM'
                  ? STATUS.PERMISSION_DENIED
                  : STATUS.FAILURE,
            );
          };
          const attrsOf = (stats: import('node:fs').Stats) => ({
            mode: Number(stats.mode),
            uid: 0,
            gid: 0,
            size: Number(stats.size),
            atime: Math.floor(Number(stats.atimeMs) / 1000),
            mtime: Math.floor(Number(stats.mtimeMs) / 1000),
          });
          sftp.on('OPEN', (reqid, filename, flags) => {
            const path = localPath(filename);
            const mode = utils.sftp.flagsToString(flags);
            if (!path || !mode) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
            try {
              const fd = openSync(path, mode);
              const id = next++;
              handles.set(id, fd);
              handleCount += 1;
              const buffer = Buffer.alloc(4);
              buffer.writeUInt32BE(id);
              sftp.handle(reqid, buffer);
            } catch (error) {
              fail(reqid, error);
            }
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            const fd = handleOf(handle);
            if (fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            const buffer = Buffer.alloc(length);
            const read = readSync(fd, buffer, 0, length, offset);
            stats.bytesRead += read;
            stats.reads.push([offset, read]);
            const answer = () => {
              try {
                if (read === 0) sftp.status(reqid, STATUS.EOF);
                else sftp.data(reqid, buffer.subarray(0, read));
              } catch {
                // The client went away meanwhile.
              }
            };
            if (hold && hold.seen++ >= hold.after) hold.held.push(answer);
            else if (state.readDelayMs > 0) setTimeout(answer, state.readDelayMs);
            else answer();
          });
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const fd = handleOf(handle);
            if (fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            writeSync(fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            const fd = handles.get(id);
            if (fd !== undefined) {
              closeSync(fd);
              handleCount -= 1;
            }
            handles.delete(id);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on('FSTAT', (reqid, handle) => {
            const fd = handleOf(handle);
            if (fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
            sftp.attrs(reqid, attrsOf(fstatSync(fd)));
          });
          const statHandler = (reqid: number, filename: string) => {
            const path = localPath(filename);
            if (!path) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
            try {
              sftp.attrs(reqid, attrsOf(statSync(path)));
            } catch (error) {
              fail(reqid, error);
            }
          };
          sftp.on('STAT', statHandler);
          sftp.on('LSTAT', statHandler);
          sftp.on('MKDIR', (reqid, filename) => {
            const path = localPath(filename);
            if (!path) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
            try {
              mkdirSync(path);
              sftp.status(reqid, STATUS.OK);
            } catch (error) {
              fail(reqid, error);
            }
          });
          sftp.on('REMOVE', (reqid, filename) => {
            const path = localPath(filename);
            if (!path) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
            try {
              unlinkSync(path);
              sftp.status(reqid, STATUS.OK);
            } catch (error) {
              fail(reqid, error);
            }
          });
          sftp.on('REALPATH', (reqid, path) => {
            sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as never }]);
          });
          sftp.on('EXTENDED', (reqid, name, data) => {
            if (name === 'fsync@openssh.com') return sftp.status(reqid, STATUS.OK);
            if (name === 'hardlink@openssh.com' && data) {
              if (!state.hardlinks) return sftp.status(reqid, STATUS.OP_UNSUPPORTED);
              const [from, to] = readStrings(data, 2) as [string, string];
              const source = localPath(from);
              const target = localPath(to);
              if (!source || !target) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
              try {
                linkSync(source, target);
                sftp.status(reqid, STATUS.OK);
              } catch (error) {
                fail(reqid, error);
              }
              return;
            }
            sftp.status(reqid, STATUS.OP_UNSUPPORTED);
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as { port: number }).port);
    });
  });
  const knownHostsLine = (name = '127.0.0.1') =>
    `[${name}]:${port} ${hostPublic[0]} ${hostPublic[1]}`;
  const knownHostsPath = join(directory, 'known_hosts');
  writeFileSync(knownHostsPath, `${knownHostsLine()}\n`);

  return {
    port,
    root,
    remoteRoot,
    username,
    knownHostsLine,
    hostKeyFingerprintBase64: hostPublic[1] as string,
    clientKeyPath,
    knownHostsPath,
    directory,
    stats,
    resetStats() {
      stats.bytesRead = 0;
      stats.reads = [];
    },
    holdReads(after = 0) {
      const current = { after, seen: 0, held: [] as Array<() => void> };
      hold = current;
      return () => {
        if (hold === current) hold = null;
        for (const answer of current.held.splice(0)) answer();
      };
    },
    heldReads: () => hold?.held.length ?? 0,
    openHandles: () => handleCount,
    openConnections: () => connections.size,
    get readDelayMs() {
      return state.readDelayMs;
    },
    set readDelayMs(value: number) {
      state.readDelayMs = value;
    },
    get hardlinks() {
      return state.hardlinks;
    },
    set hardlinks(value: boolean) {
      state.hardlinks = value;
    },
    close: async () => {
      for (const connection of connections) connection.end();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
