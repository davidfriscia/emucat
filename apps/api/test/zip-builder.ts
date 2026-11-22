import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds ZIPs and TARs as EmuCat's agent writes them, for tests: directories and files in byte order, deflated, the
 * canonical manifest last. Small and exact, so that tests can also build what an agent would refuse.
 */

export interface BuildEntry {
  name: string;
  data?: Buffer;
  /** Stored instead of deflated. */
  stored?: boolean;
  /** Unix mode bits, for entries that claim to be links or devices. */
  unixMode?: number;
}

export function buildZip(entries: BuildEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const directory = entry.name.endsWith('/');
    const method = directory || entry.stored ? 0 : 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : 0x0300 | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      entry.unixMode === undefined ? (directory ? 0x10 : 0) : (entry.unixMode << 16) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directoryBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** The canonical manifest of these files (and their directories), as the agent writes it. */
export function manifestFor(
  emulatorType: string,
  vmName: string,
  files: Record<string, Buffer>,
): { bytes: Buffer; entries: BuildEntry[] } {
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join('/'));
  }
  const listed = [
    ...[...directories].map((path) => ({ path, type: 'directory' as const })),
    ...Object.entries(files).map(([path, data]) => ({
      path,
      type: 'file' as const,
      sizeBytes: data.length,
      sha256: sha256(data),
    })),
  ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const fileList = Object.values(files);
  const manifest = {
    manifestVersion: 1,
    emulatorType,
    vmName,
    fileCount: fileList.length,
    totalUncompressedBytes: fileList.reduce((sum, data) => sum + data.length, 0),
    entries: listed,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const entries: BuildEntry[] = listed.map((entry) =>
    entry.type === 'directory'
      ? { name: `${entry.path}/` }
      : { name: entry.path, data: files[entry.path] as Buffer },
  );
  entries.push({ name: '.emucat-manifest.json', data: bytes });
  return { bytes, entries };
}

/** An EmuCat VM archive of these files. */
export function vmZip(emulatorType: string, vmName: string, files: Record<string, Buffer>) {
  const { bytes, entries } = manifestFor(emulatorType, vmName, files);
  const zip = buildZip(entries);
  return { zip, manifestSha256: sha256(bytes), manifestBytes: bytes };
}

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/** A TAR of these files in order, as an OVA is. */
export function buildTar(files: Array<[string, Buffer]>, type = '0'): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    parts.push(
      tarHeader(name, data.length, type),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    );
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
