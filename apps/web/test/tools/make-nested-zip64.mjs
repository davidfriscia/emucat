#!/usr/bin/env node
/**
 * Writes three small synthetic ZIP archives for checking the browser-local ZIP64 reader by hand (decision 0061,
 * "The browser-local reader"), outside every test suite. Each is a few KiB; no large file is read or written.
 *
 * - zip64-agent-layout.zip: entries written as the agent's zip 7.3 writes a `large_file` entry, a placeholder ZIP64
 *   record (sizes 0xFFFFFFFF) followed by the real one, with ZIP64 end records. It holds a text file, a directory, a
 *   PNG, a binary file and, inside it, a second archive in the same layout. Archive Explorer must open, browse,
 *   preview and download all of it.
 * - zip64-contradictory.zip: one entry whose two ZIP64 records give two different real sizes. Refused as damaged.
 * - zip64-oversized.zip: one entry of 1 MiB of zeros whose ZIP64 record declares 5 GiB. It lists with that size; its
 *   start can be previewed as hex, and downloading it, or opening it as an archive, is refused by the browser's limits.
 *
 * Usage: node apps/web/test/tools/make-nested-zip64.mjs <empty output directory>
 */
/* global console */
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const u16 = (value) => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};
const u64 = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};
const zip64Record = (...values) => {
  const data = Buffer.concat(values.map(u64));
  return Buffer.concat([u16(0x0001), u16(data.length), data]);
};

/**
 * entries: { name, data, method (0 or 8), records?(real) => Buffer[] }. By default, both sizes in ZIP64, written as a
 * placeholder record, then the real one.
 */
function zip64Archive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const real = entry.declared ?? data.length;
    const records = entry.records
      ? entry.records(real, stored.length)
      : [zip64Record(0xffffffff, 0xffffffff), zip64Record(real, stored.length)];
    const localExtra = zip64Record(data.length, stored.length);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(45),
      u16(0x0800),
      u16(method),
      u16(0),
      u16(0x5b21),
      u32(crc),
      u32(0xffffffff),
      u32(0xffffffff),
      u16(name.length),
      u16(localExtra.length),
      name,
      localExtra,
      stored,
    ]);
    const centralExtra = Buffer.concat(records);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(45),
        u16(45),
        u16(0x0800),
        u16(method),
        u16(0),
        u16(0x5b21),
        u32(crc),
        u32(0xffffffff),
        u32(0xffffffff),
        u16(name.length),
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.name.endsWith('/') ? 0x10 : 0),
        u32(offset),
        name,
        centralExtra,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end64 = Buffer.concat([
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
  ]);
  const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(offset + directory.length), u32(1)]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(0xffff),
    u16(0xffff),
    u32(0xffffffff),
    u32(0xffffffff),
    u16(0),
  ]);
  return Buffer.concat([...locals, directory, end64, locator, end]);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const text = (value) => Buffer.from(value, 'utf8');

const out = process.argv[2];
if (!out) {
  console.error('Usage: node make-nested-zip64.mjs <empty output directory>');
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} is not empty.`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const inner = zip64Archive([
  { name: 'INSTALL.TXT', data: text('ZIP64 inner archive: run INSTALL.EXE from drive A:\r\n') },
]);
const files = {
  'zip64-agent-layout.zip': zip64Archive([
    { name: 'README.TXT', data: text('EmuCat M0.1 ZIP64 test archive\r\n'.repeat(8)) },
    { name: 'docs/', method: 0 },
    { name: 'docs/setup.png', data: PNG_1X1, method: 0 },
    {
      name: 'MOUSE.COM',
      data: Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 37) % 256)),
    },
    { name: 'drivers.zip', data: inner, method: 0 },
  ]),
  'zip64-contradictory.zip': zip64Archive([
    {
      name: 'README.TXT',
      data: text('two answers'),
      method: 0,
      records: (real, stored) => [zip64Record(real, stored), zip64Record(real + 1, stored)],
    },
  ]),
  'zip64-oversized.zip': zip64Archive([
    { name: 'disk.raw', data: Buffer.alloc(1024 * 1024), declared: 5 * 1024 ** 3 },
  ]),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(out, name), bytes);
  console.log(`${name}\t${bytes.length} bytes`);
}
