/**
 * Archive Explorer on a real OVA (decision 0057), end to end: the OVA named by EMUCAT_OVA_FIXTURE is served by a
 * real SFTP repository and read through the API exactly as an administrator's browser does. Skipped without it:
 *
 *   EMUCAT_OVA_FIXTURE=C:\path\to\export.ova pnpm --filter @emucat/api exec vitest run archive-explorer-real-ova
 *
 * The fixture itself is never written: the test repository holds a copy, removed with the test's SFTP server. Every
 * entry is checked against the OVA's own manifest (SHA-1 lines, as VirtualBox writes them), so the reference
 * contents do not come from EmuCat's parser.
 */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ARCHIVE_PREVIEW_HEADERS as H,
  archiveEntryDetailsSchema,
  archiveListingResponseSchema,
  archiveObjectKey,
  archiveSummarySchema,
} from '@emucat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { readTar } from '../src/archives/tar.js';
import { openLocal } from '../src/archives/zip.js';
import { DEFAULT_ARCHIVE_POLICY } from '../src/archives/policy.js';
import { insertVm } from './browser-app.js';
import { closeServers, serverWorld } from './server-world.js';
import { closeWorlds, errorCode } from './version-world.js';

afterEach(async () => {
  await closeWorlds();
  await closeServers();
});

const fixture = process.env.EMUCAT_OVA_FIXTURE;

async function slice(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fileSha256(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: 1 << 20 })) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

describe.skipIf(!fixture || !existsSync(fixture))('Archive Explorer: a real OVA', () => {
  it('lists, previews and downloads entries of an OVA without an end marker', async () => {
    const path = fixture as string;
    const before = await fileSha256(path);
    const w = await serverWorld({
      overrides: {
        archives: {
          ...DEFAULT_ARCHIVE_POLICY,
          // Below the disk's size, above the descriptor's and manifest's: the disk's download must be refused.
          download: { ...DEFAULT_ARCHIVE_POLICY.download, maxBytes: 1024 * 1024 },
        },
      },
    });
    const vm = { emulatorType: 'virtualbox' as const, vmName: 'Xenix386' };
    await insertVm(w.context.pool, vm);
    // Registered as an agent registers an OVA: the object under its key, with its size and SHA-256. The test holds
    // the fixture in memory once, to write the test repository's copy; the server never does.
    const { id, key } = await w.insertVersion(await readFile(path), { vm });
    const object = join(w.sftp.root, key);
    expect(key).toBe(archiveObjectKey(vm, id));
    const base = `/admin/vms/virtualbox/${vm.vmName}/versions/${id}/archive`;

    const scratch = mkdtempSync(join(tmpdir(), 'emucat-real-ova-'));
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: scratch, TEMP: scratch, TMP: scratch });
    expect(tmpdir()).toBe(scratch);
    const repository = readdirSync(dirname(object)).sort();
    const measured: Record<string, number> = { archiveBytes: before.size };
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      w.sftp.resetStats();
      const result = await run();
      measured[name] = w.sftp.stats.bytesRead;
      return result;
    };
    try {
      // 1. The summary: an OVA, three files, nothing but headers read.
      const summaryResponse = await step('listing', () => w.admin.get(base));
      expect(summaryResponse.statusCode, summaryResponse.body).toBe(200);
      const summary = archiveSummarySchema.parse(summaryResponse.json());
      expect(summary.archive.format).toBe('ova');
      expect(summary.views).toEqual(['physical']);
      const listing = archiveListingResponseSchema.parse(
        (await w.admin.get(`${base}/entries?view=physical`)).json(),
      );
      expect(listing.total).toBe(summary.physical.entryCount);
      const entries = listing.entries;
      const ovf = entries.find((entry) => entry.name.toLowerCase().endsWith('.ovf'));
      const mf = entries.find((entry) => entry.name.toLowerCase().endsWith('.mf'));
      const vmdk = entries.find((entry) => entry.name.toLowerCase().endsWith('.vmdk'));
      if (!ovf || !vmdk) throw new Error('The fixture is not a VirtualBox OVA');
      // A listing of an OVA reads one 512-byte header per entry, and nothing else.
      expect(measured.listing).toBe(512 * entries.length);
      const q = (entryPath: string, extra: Record<string, string> = {}) =>
        new URLSearchParams({ view: 'physical', path: entryPath, ...extra }).toString();

      // 2. The descriptor: XML, previewed as text, complete, without touching the disk.
      const details = archiveEntryDetailsSchema.parse(
        (await w.admin.get(`${base}/entry?${q(ovf.path)}`)).json(),
      );
      expect(details.detected).toMatchObject({ kind: 'text', language: 'xml' });
      const text = await step('descriptorPreview', () =>
        w.admin.get(`${base}/entry/preview?${q(ovf.path, { kind: 'text' })}`),
      );
      expect(text.statusCode, text.body).toBe(200);
      expect(text.headers[H.integrity]).toBe('complete');
      expect(text.body).toContain('<Envelope');
      expect(measured.descriptorPreview).toBeLessThanOrEqual((ovf.sizeBytes ?? 0) + 512);

      // 3. The manifest, as text, and the reference digests it holds.
      const digests = new Map<string, string>();
      if (mf) {
        const manifest = await w.admin.get(`${base}/entry/preview?${q(mf.path, { kind: 'text' })}`);
        expect(manifest.statusCode).toBe(200);
        for (const line of manifest.body.split('\n')) {
          const match = /^SHA(1|256) ?\((.+)\) ?= ?([0-9a-f]+)$/iu.exec(line.trim());
          if (match)
            digests.set(match[2] as string, `${match[1]}:${(match[3] as string).toLowerCase()}`);
        }
      }

      // 4. Small downloads, byte for byte as the manifest and the file itself say.
      for (const entry of [ovf, mf].filter((value) => value !== undefined)) {
        const download = await step(`download:${entry.name}`, () =>
          w.admin.get(`${base}/entry/download?${q(entry.path)}`),
        );
        expect(download.statusCode, download.body).toBe(200);
        expect(download.rawPayload.length).toBe(entry.sizeBytes);
        const digest = digests.get(entry.name);
        if (digest) {
          const [algorithm, value] = digest.split(':') as [string, string];
          const actual = createHash(algorithm === '1' ? 'sha1' : 'sha256')
            .update(download.rawPayload)
            .digest('hex');
          expect(actual, entry.name).toBe(value);
        }
      }

      // 5. The disk's header in hex: the VMDK magic, exactly the file's bytes at that entry's data offset.
      const hex = await step('diskHexPreview', () =>
        w.admin.get(`${base}/entry/preview?${q(vmdk.path, { kind: 'hex' })}`),
      );
      expect(hex.statusCode, hex.body).toBe(200);
      const offset = Number(hex.headers[H.offset] ?? 0);
      expect(offset).toBe(0);
      expect(hex.rawPayload.length).toBe(
        Math.min(DEFAULT_ARCHIVE_POLICY.preview.hexBytes, vmdk.sizeBytes ?? 0),
      );
      expect(measured.diskHexPreview).toBeLessThanOrEqual(hex.rawPayload.length + 4096);
      // The reference: the fixture's own bytes at the disk's data offset, read directly.
      const local = await openLocal(path);
      const dataOffset = await readTar(local)
        .then((all) => all.find((entry) => entry.name === vmdk.name)?.dataOffset)
        .finally(() => local.close());
      expect(dataOffset).toBeDefined();
      expect(
        hex.rawPayload.equals(await slice(path, dataOffset as number, hex.rawPayload.length)),
      ).toBe(true);
      measured.diskDataOffset = dataOffset as number;
      measured.diskMagic = hex.rawPayload.readUInt32LE(0);

      // 6. And the disk is too large to download with this policy.
      const big = await w.admin.get(`${base}/entry/download?${q(vmdk.path)}`);
      expect([big.statusCode, await errorCode(big)]).toEqual([413, 'download_too_large']);
      // Measured byte counts, reported by the compatibility fix's report.
      console.info(
        JSON.stringify({ entries: entries.map((e) => [e.name, e.sizeBytes]), ...measured }),
      );
    } finally {
      Object.assign(process.env, saved);
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
    }
    expect(readdirSync(scratch)).toEqual([]);
    rmSync(scratch, { recursive: true });
    expect(readdirSync(dirname(object)).sort()).toEqual(repository);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (w.sftp.openConnections() === 0 && w.sftp.openHandles() === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect([w.sftp.openConnections(), w.sftp.openHandles()]).toEqual([0, 0]);
    // The fixture is exactly as it was.
    expect(await fileSha256(path)).toEqual(before);
  }, 120_000);
});
