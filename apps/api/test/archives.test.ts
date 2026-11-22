import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArchiveCheckError,
  canonicalManifestBytes,
  entryPathProblem,
  inspectZip,
  MANIFEST_ENTRY_NAME,
  type Manifest,
} from '../src/archives/manifest.js';
import { checkOvaLayout, readTar } from '../src/archives/tar.js';
import { hashEntry, openLocal, readCentralDirectory, rewriteZip } from '../src/archives/zip.js';
import { buildTar, buildZip, manifestFor, sha256, vmZip } from './zip-builder.js';

const memory = (data: Buffer) => ({
  sizeBytes: data.length,
  read: async (offset: number, length: number) => data.subarray(offset, offset + length),
});

const FILES = {
  'disks/hdd.img': Buffer.alloc(200_000, 7),
  'vm.cfg': Buffer.from('[General]\nmachine = ibmpc\n'),
  'nvr/ibmpc.nvr': Buffer.from([1, 2, 3, 4]),
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('the manifest', () => {
  it('is canonical exactly as the agent writes it', () => {
    const { bytes } = manifestFor('86box', 'DOS622', FILES);
    const parsed = JSON.parse(bytes.toString()) as Manifest;
    expect(canonicalManifestBytes(parsed).equals(bytes)).toBe(true);
  });

  it('refuses paths that a restore would refuse', () => {
    for (const path of [
      '../x',
      '/abs',
      'a\\b',
      'C:x',
      'a//b',
      'CON.txt',
      'dir/aux',
      'trail.',
      'sp ',
      'a/./b',
      '',
    ]) {
      expect(entryPathProblem(path), path).not.toBeNull();
    }
    for (const path of ['vm.cfg', 'disks/hdd.img', 'a b/c-d_e.f']) {
      expect(entryPathProblem(path), path).toBeNull();
    }
  });
});

describe('inspecting a ZIP', () => {
  it('accepts an archive registered by an agent, and reports its manifest', async () => {
    const { zip, manifestSha256 } = vmZip('86box', 'DOS622', FILES);
    const inspected = await inspectZip(memory(zip), {
      emulatorType: '86box',
      vmName: 'dos622',
      manifestSha256,
    });
    expect(inspected.manifest.fileCount).toBe(3);
    expect(inspected.manifestSha256).toBe(manifestSha256);
    expect(inspected.entries.at(-1)?.name).toBe(MANIFEST_ENTRY_NAME);
  });

  it('refuses another VM’s archive, and a manifest other than the registered one', async () => {
    const { zip } = vmZip('86box', 'DOS622', FILES);
    await expect(
      inspectZip(memory(zip), { emulatorType: '86box', vmName: 'Other', manifestSha256: null }),
    ).rejects.toMatchObject({ kind: 'identity' });
    await expect(
      inspectZip(memory(zip), { emulatorType: 'qemu', vmName: 'DOS622', manifestSha256: null }),
    ).rejects.toMatchObject({ kind: 'identity' });
    await expect(
      inspectZip(memory(zip), {
        emulatorType: '86box',
        vmName: 'DOS622',
        manifestSha256: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ kind: 'integrity' });
  });

  it('refuses traversal, duplicates by case, links, extra entries and a missing manifest', async () => {
    const { entries } = manifestFor('86box', 'DOS622', FILES);
    const variants: Array<[string, typeof entries]> = [
      ['traversal', [{ name: '../evil', data: Buffer.from('x') }, ...entries]],
      ['case duplicate', [{ name: 'VM.CFG', data: Buffer.from('x') }, ...entries]],
      [
        'symlink',
        [{ name: 'link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }, ...entries],
      ],
      ['extra entry', [{ name: 'extra.bin', data: Buffer.from('x') }, ...entries]],
      ['no manifest', entries.slice(0, -1)],
      [
        'imitated manifest',
        [...entries.slice(0, -1), { name: '.EMUCAT-MANIFEST.JSON', data: Buffer.from('{}') }],
      ],
    ];
    for (const [label, list] of variants) {
      await expect(
        inspectZip(memory(buildZip(list)), {
          emulatorType: '86box',
          vmName: 'DOS622',
          manifestSha256: null,
        }),
        label,
      ).rejects.toBeInstanceOf(ArchiveCheckError);
    }
  });

  it('refuses a manifest that is not canonical, or whose sizes differ from the entries', async () => {
    const { bytes, entries } = manifestFor('86box', 'DOS622', FILES);
    const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2));
    const prettyZip = buildZip([
      ...entries.slice(0, -1),
      { name: MANIFEST_ENTRY_NAME, data: pretty },
    ]);
    await expect(
      inspectZip(memory(prettyZip), {
        emulatorType: '86box',
        vmName: 'DOS622',
        manifestSha256: null,
      }),
    ).rejects.toThrow(/canonical/);
    const resized = entries.map((entry) =>
      entry.name === 'vm.cfg'
        ? { ...entry, data: Buffer.from('a longer replacement than the original file') }
        : entry,
    );
    await expect(
      inspectZip(memory(buildZip(resized)), {
        emulatorType: '86box',
        vmName: 'DOS622',
        manifestSha256: null,
      }),
    ).rejects.toMatchObject({ kind: 'integrity' });
  });

  it('refuses a central directory larger than allowed, rather than reading it', async () => {
    const { zip } = vmZip('86box', 'DOS622', FILES);
    await expect(
      inspectZip(
        memory(zip),
        { emulatorType: '86box', vmName: 'DOS622', manifestSha256: null },
        { maxEntries: 2, maxDirectoryBytes: 1 << 20, maxManifestBytes: 1 << 20 },
      ),
    ).rejects.toMatchObject({ kind: 'limit' });
  });
});

describe('rewriting a ZIP for a clone', () => {
  it('copies every entry, replaces the manifest last, and the result passes as the new VM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emucat-zip-'));
    directories.push(directory);
    const { zip } = vmZip('86box', 'DOS622', FILES);
    const source = join(directory, 'source.zip');
    const target = join(directory, 'clone.zip');
    await writeFile(source, zip);
    const inspected = await inspectZip(memory(zip), {
      emulatorType: '86box',
      vmName: 'DOS622',
      manifestSha256: null,
    });
    const renamed = canonicalManifestBytes({ ...inspected.manifest, vmName: 'DOS622-Copy' });
    await rewriteZip(
      source,
      target,
      MANIFEST_ENTRY_NAME,
      MANIFEST_ENTRY_NAME,
      renamed,
      { maxEntries: 1000, maxDirectoryBytes: 1 << 20 },
      () => undefined,
    );
    const written = await readFile(target);
    const clone = await inspectZip(memory(written), {
      emulatorType: '86box',
      vmName: 'DOS622-Copy',
      manifestSha256: sha256(renamed),
    });
    expect(clone.manifest.entries).toEqual(inspected.manifest.entries);
    expect(clone.entries.at(-1)?.name).toBe(MANIFEST_ENTRY_NAME);
    // Every file decompresses to what the manifest says.
    const local = await openLocal(target);
    try {
      const { entries } = await readCentralDirectory(local, {
        maxEntries: 100,
        maxDirectoryBytes: 1 << 20,
      });
      for (const entry of entries) {
        const listed = clone.manifest.entries.find((item) => item.path === entry.name);
        if (listed?.type !== 'file') continue;
        expect(await hashEntry(target, local, entry, () => undefined)).toBe(listed.sha256);
      }
    } finally {
      await local.close();
    }
    // Never over an existing file.
    await expect(
      rewriteZip(
        source,
        target,
        MANIFEST_ENTRY_NAME,
        MANIFEST_ENTRY_NAME,
        renamed,
        { maxEntries: 1000, maxDirectoryBytes: 1 << 20 },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('reading an OVA', () => {
  it('lists a flat TAR with the descriptor first', async () => {
    const tar = buildTar([
      ['vm.ovf', Buffer.from('<Envelope/>')],
      ['vm-disk001.vmdk', Buffer.alloc(3000, 1)],
      ['vm.mf', Buffer.from('SHA256(vm.ovf)= 00\n')],
    ]);
    const entries = await readTar(memory(tar));
    expect(entries.map((entry) => entry.name)).toEqual(['vm.ovf', 'vm-disk001.vmdk', 'vm.mf']);
    expect(entries[1]?.sizeBytes).toBe(3000);
    expect(() => checkOvaLayout(entries)).not.toThrow();
  });

  it('refuses directories, nesting, traversal and a misplaced descriptor', async () => {
    await expect(readTar(memory(buildTar([['dir/', Buffer.alloc(0)]], '5')))).rejects.toThrow();
    await expect(readTar(memory(buildTar([['a/b.vmdk', Buffer.alloc(1)]])))).rejects.toThrow();
    await expect(readTar(memory(buildTar([['../x.ovf', Buffer.alloc(1)]])))).rejects.toThrow();
    const late = await readTar(
      memory(
        buildTar([
          ['disk.vmdk', Buffer.alloc(1)],
          ['vm.ovf', Buffer.alloc(1)],
        ]),
      ),
    );
    expect(() => checkOvaLayout(late)).toThrow(/first/);
  });

  it('refuses a damaged header', async () => {
    const tar = buildTar([['vm.ovf', Buffer.from('<Envelope/>')]]);
    tar[0] = 'x'.charCodeAt(0);
    await expect(readTar(memory(tar))).rejects.toThrow(/checksum/);
  });
});
