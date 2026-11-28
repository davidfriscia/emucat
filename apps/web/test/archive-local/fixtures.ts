import { deflateSync, gzipSync } from 'fflate';
import { crc32 } from '../../src/archive-local/bytes';

/**
 * Small synthetic archives, built in memory for the tests (decision 0058). Nothing here is copyrighted or large: every
 * fixture is a few hundred bytes of made-up content, except the decompression bombs, which are a few KiB that
 * claim, or expand to, much more.
 */

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export interface ZipFile {
  name: string;
  data?: Uint8Array;
  /** 0 stored, 8 deflated, or any other method number, written as if it were stored. */
  method?: number;
  flags?: number;
  /** Unix mode for the external attributes (sets "made by Unix"). */
  mode?: number;
  /** Override the recorded CRC-32 (to make a corrupt entry). */
  crc?: number;
  /** Override the recorded uncompressed size (to make a lying entry). */
  size?: number;
  /** The name's bytes as stored, for CP437 names. */
  rawName?: Uint8Array;
  directory?: boolean;
}

const u16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number) => [...u16(value & 0xffff), ...u16((value >>> 16) & 0xffff)];
const u64 = (value: number) => [...u32(value >>> 0), ...u32(Math.floor(value / 2 ** 32))];

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A ZIP; with `zip64`, every entry and the end records use ZIP64 fields. */
export function zip(
  files: ZipFile[],
  options: { zip64?: boolean; comment?: string } = {},
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const data = file.data ?? new Uint8Array(0);
    const method = file.method ?? (file.directory ? 0 : 8);
    const stored = method === 8 ? deflateSync(data) : data;
    const name = file.rawName ?? text(file.name);
    const flags = file.flags ?? (file.rawName ? 0 : 0x0800);
    const crc = file.crc ?? crc32(data);
    const size = file.size ?? data.length;
    const z64 = options.zip64 === true;
    const extraLocal = z64 ? [...u16(1), ...u16(16), ...u64(size), ...u64(stored.length)] : [];
    const local = concat([
      u32(0x04034b50),
      u16(z64 ? 45 : 20),
      u16(flags),
      u16(method),
      u16(0x6000),
      u16(0x5821),
      u32(crc),
      u32(z64 ? 0xffffffff : stored.length),
      u32(z64 ? 0xffffffff : size),
      u16(name.length),
      u16(extraLocal.length),
      name,
      extraLocal,
      stored,
    ]);
    const extraCentral = z64
      ? [...u16(1), ...u16(24), ...u64(size), ...u64(stored.length), ...u64(offset)]
      : [];
    const madeBy = file.mode !== undefined ? (3 << 8) | 20 : 20;
    const external = file.mode !== undefined ? (file.mode << 16) >>> 0 : file.directory ? 0x10 : 0;
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(madeBy),
        u16(z64 ? 45 : 20),
        u16(flags),
        u16(method),
        u16(0x6000),
        u16(0x5821),
        u32(crc),
        u32(z64 ? 0xffffffff : stored.length),
        u32(z64 ? 0xffffffff : size),
        u16(name.length),
        u16(extraCentral.length),
        u16(0),
        u16(0),
        u16(0),
        u32(external),
        u32(z64 ? 0xffffffff : offset),
        name,
        extraCentral,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = concat(centrals);
  const comment = text(options.comment ?? '');
  const parts: (Uint8Array | number[])[] = [...locals, directory];
  if (options.zip64) {
    const recordOffset = offset + directory.length;
    parts.push(
      concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(files.length),
        u64(files.length),
        u64(directory.length),
        u64(offset),
      ]),
      concat([u32(0x07064b50), u32(0), u64(recordOffset), u32(1)]),
    );
  }
  parts.push(
    concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(options.zip64 ? 0xffff : files.length),
      u16(options.zip64 ? 0xffff : files.length),
      u32(options.zip64 ? 0xffffffff : directory.length),
      u32(options.zip64 ? 0xffffffff : offset),
      u16(comment.length),
      comment,
    ]),
  );
  return concat(parts);
}

export interface TarFile {
  name: string;
  data?: Uint8Array;
  type?: string;
  linkName?: string;
}

function tarHeader(name: string, size: number, type: string, linkName = ''): Uint8Array {
  const block = new Uint8Array(512);
  block.set(text(name).subarray(0, 100), 0);
  const octal = (value: number, length: number) =>
    text(value.toString(8).padStart(length - 1, '0') + '\0');
  block.set(octal(0o644, 8), 100);
  block.set(octal(0, 8), 108);
  block.set(octal(0, 8), 116);
  block.set(octal(size, 12), 124);
  block.set(octal(1_700_000_000, 12), 136);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.set(text(linkName).subarray(0, 100), 157);
  block.set(text('ustar\0'), 257);
  block.set(text('00'), 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(text(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return block;
}

/** A TAR. `end` says how it ends: two zero blocks (default), one, or none (the 0057 exact-boundary case). */
export function tar(files: TarFile[], options: { end?: 0 | 1 | 2 } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const data = file.data ?? new Uint8Array(0);
    const type = file.type ?? '0';
    const size = type === '0' || type === '7' ? data.length : 0;
    parts.push(tarHeader(file.name, size, type, file.linkName));
    if (size > 0) {
      parts.push(data);
      const padding = (512 - (size % 512)) % 512;
      if (padding) parts.push(new Uint8Array(padding));
    }
  }
  for (let index = 0; index < (options.end ?? 2); index += 1) parts.push(new Uint8Array(512));
  return concat(parts);
}

export const gzip = (data: Uint8Array, name?: string): Uint8Array =>
  gzipSync(data, name ? { filename: name, mtime: 1_700_000_000_000 } : { mtime: 0 });

/** A 1×1 PNG and a 2×1 PPM, a 2x2 GIF: tiny real images. */
export const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
export const PPM_2X1 = concat([text('P6\n2 1\n255\n'), [255, 0, 0, 0, 0, 255]]);
export const PDF_MINIMAL = text(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** One extra-field record: its header ID, its length, then its data. */
export const extraField = (id: number, data: Uint8Array | number[]): Uint8Array =>
  concat([u16(id), u16(data.length), data]);

const u64Big = (value: number | bigint) => {
  const big = BigInt(value);
  return [...u32(Number(big & 0xffffffffn)), ...u32(Number((big >> 32n) & 0xffffffffn))];
};

/** The data of a ZIP64 extended-information record holding these 64-bit values, in order. */
export const zip64Data = (...values: Array<number | bigint>): Uint8Array =>
  concat(values.map(u64Big));

/** The fixed fields of a central record that are 0xFFFFFFFF, each expanded in ZIP64. */
export interface Zip64Fields {
  uncompressed: boolean;
  compressed: boolean;
  offset: boolean;
}

export interface Zip64LayoutEntry {
  name: string;
  data?: Uint8Array;
  /** 0 stored, 8 deflated (default). */
  method?: number;
  /** Override the recorded CRC-32. */
  crc?: number;
  /**
   * How the central record uses ZIP64 (decision 0061). `fields` says which fixed fields are 0xFFFFFFFF; by default
   * both sizes, as the agent's zip 7.3 writes them for `large_file`. `records` is `agent` (the placeholder record,
   * then the real one: the agent's layout), `single` (the real one only), `none` (no ZIP64 record, though the fields
   * say ZIP64), or the raw data of each ZIP64 record. `false`: no ZIP64 at all.
   */
  zip64?:
    false | { fields?: Partial<Zip64Fields>; records?: 'agent' | 'single' | 'none' | Uint8Array[] };
  /** The real values written into the real ZIP64 record, instead of the entry's own (a lying record). */
  real?: Partial<{ uncompressed: number | bigint; compressed: number | bigint }>;
  /** Raw extra-field records (any IDs) placed before and after the ZIP64 records of the central record. */
  extraBefore?: Uint8Array;
  extraAfter?: Uint8Array;
  /** Raw bytes for the whole central extra field, framing included (to make a broken one). */
  centralExtra?: Uint8Array;
}

/**
 * A ZIP whose central records carry exactly the ZIP64 records asked for, as the API's `buildZip64Layout` does for
 * the server (decision 0061), but small and in memory. Local headers are written as the agent writes them when an
 * entry uses ZIP64: sizes 0xFFFFFFFF and one local ZIP64 record with the real sizes. `end64` adds the ZIP64 end
 * record and locator (with the classic end record full of markers).
 */
export function zip64Layout(
  entries: Zip64LayoutEntry[],
  options: { end64?: boolean } = {},
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateSync(data) : data;
    const name = text(entry.name);
    const crc = entry.crc ?? crc32(data);
    const layout = entry.zip64 === false ? null : (entry.zip64 ?? {});
    const fields: Zip64Fields = {
      uncompressed: layout?.fields?.uncompressed ?? layout !== null,
      compressed: layout?.fields?.compressed ?? layout !== null,
      offset: layout?.fields?.offset ?? false,
    };
    const realUncompressed = entry.real?.uncompressed ?? data.length;
    const realCompressed = entry.real?.compressed ?? stored.length;
    const real: Array<number | bigint> = [];
    const placeholder: Array<number | bigint> = [];
    if (fields.uncompressed) {
      real.push(realUncompressed);
      placeholder.push(0xffffffff);
    }
    if (fields.compressed) {
      real.push(realCompressed);
      placeholder.push(0xffffffff);
    }
    if (fields.offset) {
      real.push(offset);
      placeholder.push(offset);
    }
    const records =
      layout === null || layout.records === 'none'
        ? []
        : layout.records === 'single'
          ? [zip64Data(...real)]
          : layout.records === undefined || layout.records === 'agent'
            ? [zip64Data(...placeholder), zip64Data(...real)]
            : layout.records;
    const localZip64 = layout !== null;
    const localExtra = localZip64
      ? extraField(1, zip64Data(data.length, stored.length))
      : new Uint8Array(0);
    const local = concat([
      u32(0x04034b50),
      u16(localZip64 ? 45 : 20),
      u16(0x0800),
      u16(method),
      u16(0x6000),
      u16(0x5821),
      u32(crc),
      u32(localZip64 ? 0xffffffff : stored.length),
      u32(localZip64 ? 0xffffffff : data.length),
      u16(name.length),
      u16(localExtra.length),
      name,
      localExtra,
      stored,
    ]);
    const centralExtra =
      entry.centralExtra ??
      concat([
        entry.extraBefore ?? new Uint8Array(0),
        ...records.map((record) => extraField(1, record)),
        entry.extraAfter ?? new Uint8Array(0),
      ]);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(localZip64 ? 45 : 20),
        u16(0x0800),
        u16(method),
        u16(0x6000),
        u16(0x5821),
        u32(crc),
        u32(fields.compressed ? 0xffffffff : stored.length),
        u32(fields.uncompressed ? 0xffffffff : data.length),
        u16(name.length),
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(fields.offset ? 0xffffffff : offset),
        name,
        centralExtra,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = concat(centrals);
  const parts: (Uint8Array | number[])[] = [...locals, directory];
  const end64 = options.end64 === true;
  if (end64) {
    parts.push(
      concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(entries.length),
        u64(entries.length),
        u64(directory.length),
        u64(offset),
      ]),
      concat([u32(0x07064b50), u32(0), u64(offset + directory.length), u32(1)]),
    );
  }
  parts.push(
    concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(end64 ? 0xffff : entries.length),
      u16(end64 ? 0xffff : entries.length),
      u32(end64 ? 0xffffffff : directory.length),
      u32(end64 ? 0xffffffff : offset),
      u16(0),
    ]),
  );
  return concat(parts);
}
