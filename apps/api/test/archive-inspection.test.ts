/**
 * View Archive Contents and Test Server Connection (decision 0055): administrators look inside a version's archive
 * and check the server's own repository connection, over that connection, changing nothing.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  archiveListingResponseSchema,
  archiveSummarySchema,
  repositoryListResponseSchema,
  serverConnectionTestSchema,
} from '@emucat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { insertVm, TestClient } from './browser-app.js';
import { closeServers, serverWorld, type ServerWorld } from './server-world.js';
import { closeWorlds, world } from './version-world.js';
import { buildTar, sha256, vmZip } from './zip-builder.js';

afterEach(async () => {
  await closeWorlds();
  await closeServers();
});

const FILES: Record<string, Buffer> = {
  'vm.cfg': Buffer.from('[General]\n'),
  'disks/hdd0.img': Buffer.alloc(40_000, 1),
  'disks/hdd1.img': Buffer.alloc(10, 2),
  'nvr/ibmpc.nvr': Buffer.from([1, 2, 3]),
};

async function zipVersion(w: ServerWorld) {
  await insertVm(w.context.pool, { emulatorType: '86box', vmName: 'DOS622' });
  const { zip, manifestSha256 } = vmZip('86box', 'DOS622', FILES);
  const { id, key } = await w.insertVersion(zip, {
    vm: { emulatorType: '86box', vmName: 'DOS622' },
  });
  await w.context.pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key,
        archive_size_bytes, archive_sha256, manifest_version, manifest_sha256, committed_at, finished_at, local_copy)
     VALUES (?, ?, ?, '86box', 'DOS622', 'copy', 'succeeded', ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(3),
       UTC_TIMESTAMP(3), 'preserved')`,
    [
      randomUUID(),
      w.paired.agentId,
      w.repository.id,
      id,
      key,
      zip.length,
      sha256(zip),
      manifestSha256,
    ],
  );
  return { id, key, zip, manifestSha256 };
}

const base = (versionId: string) => `/admin/vms/86box/DOS622/versions/${versionId}/archive`;

describe('View Archive Contents', () => {
  it('summarizes a ZIP version as a complete archive, with its manifest', async () => {
    const w = await serverWorld();
    const { id, zip, manifestSha256 } = await zipVersion(w);
    const response = await w.admin.get(base(id));
    expect(response.statusCode, response.body).toBe(200);
    const summary = archiveSummarySchema.parse(response.json());
    expect(summary).toMatchObject({
      complete: true,
      archive: { format: 'zip', sizeBytes: zip.length, sha256: sha256(zip), repositoryName: 'NAS' },
      manifest: {
        vmName: 'DOS622',
        fileCount: 4,
        directoryCount: 2,
        sha256: manifestSha256,
        matchesRegistration: true,
      },
      physical: { entryCount: 7, fileCount: 5, directoryCount: 2 },
      views: ['logical', 'physical'],
      warnings: [],
    });
    expect(summary.archive.fileName).toBe(`${id}.zip`);
  });

  it('lists one directory at a time, directories first, and pages and searches', async () => {
    const w = await serverWorld();
    const { id } = await zipVersion(w);
    const list = async (query: string) => {
      const response = await w.admin.get(`${base(id)}/entries?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return archiveListingResponseSchema.parse(response.json());
    };
    const root = await list('view=logical');
    expect(root.entries.map((entry) => [entry.name, entry.type, entry.childCount])).toEqual([
      ['disks', 'directory', 2],
      ['nvr', 'directory', 1],
      ['vm.cfg', 'file', null],
    ]);
    const disks = await list('view=logical&path=disks');
    expect(disks.entries.map((entry) => entry.path)).toEqual(['disks/hdd0.img', 'disks/hdd1.img']);
    expect(disks.entries[0]).toMatchObject({
      sizeBytes: 40_000,
      sha256: sha256(FILES['disks/hdd0.img'] as Buffer),
    });

    const paged = await list('view=logical&path=disks&limit=1');
    expect(paged).toMatchObject({ total: 2, nextOffset: 1 });
    expect((await list('view=logical&path=disks&limit=1&offset=1')).nextOffset).toBeNull();

    const found = await list('view=logical&q=HDD');
    expect(found.entries.map((entry) => entry.path)).toEqual(['disks/hdd0.img', 'disks/hdd1.img']);

    // The physical view shows what is stored, the manifest included, with compression.
    const physical = await list('view=physical');
    expect(physical.entries.map((entry) => entry.name)).toContain('.emucat-manifest.json');
    const physicalDisks = await list('view=physical&path=disks');
    expect(physicalDisks.entries[0]).toMatchObject({ method: 'deflated', sizeBytes: 40_000 });
    expect(physicalDisks.entries[0]?.compressedSizeBytes).toBeLessThan(40_000);

    const missing = await w.admin.get(`${base(id)}/entries?path=../etc`);
    expect(missing.statusCode).toBe(404);
  });

  it('lists an OVA physically only', async () => {
    const w = await serverWorld();
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: 'XP' });
    const ova = buildTar([
      ['xp.ovf', Buffer.from('<Envelope/>')],
      ['xp-disk001.vmdk', Buffer.alloc(2000, 4)],
    ]);
    const { id } = await w.insertVersion(ova, { vm: { emulatorType: 'virtualbox', vmName: 'XP' } });
    const url = `/admin/vms/virtualbox/XP/versions/${id}/archive`;
    const summary = archiveSummarySchema.parse((await w.admin.get(url)).json());
    expect(summary).toMatchObject({
      manifest: null,
      views: ['physical'],
      archive: { format: 'ova' },
    });
    const entries = archiveListingResponseSchema.parse(
      (await w.admin.get(`${url}/entries?view=physical`)).json(),
    );
    expect(entries.entries.map((entry) => entry.name)).toEqual(['xp-disk001.vmdk', 'xp.ovf']);
    expect((await w.admin.get(`${url}/entries?view=logical`)).statusCode).toBe(409);
  });

  it('refuses an archive that is damaged or not the registered size, and changes nothing', async () => {
    const w = await serverWorld();
    const { id, key, zip } = await zipVersion(w);
    await w.put(key, zip.subarray(0, zip.length - 1));
    const short = await w.admin.get(base(id));
    expect(short.statusCode).toBe(409);
    expect(short.json()).toMatchObject({ error: { code: 'archive_size_mismatch' } });

    const garbage = Buffer.alloc(zip.length, 0x41);
    await w.put(key, garbage);
    const damaged = await w.admin.get(base(id));
    expect(damaged.statusCode).toBe(422);
    expect(damaged.json()).toMatchObject({ error: { code: 'archive_malformed' } });
    // Nothing was written in the repository.
    expect(readdirSync(join(w.sftp.root, 'archives'))).toEqual(['86box']);
  });

  it('is for administrators, and says when the server has no repository connection', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    const url = `/admin/vms/qemu/Win98/versions/${w.masterId}/archive`;
    expect((await anonymous.get(url)).statusCode).toBe(401);
    const unavailable = await w.admin.get(url);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'server_repository_unavailable' } });
    // Another VM's version is not found through this one.
    expect(
      (await w.admin.get(`/admin/vms/qemu/Other/versions/${w.masterId}/archive`)).statusCode,
    ).toBe(404);
  });
});

describe('Test Server Connection', () => {
  it('tests the server-side address, records the result, and shows it with the repository', async () => {
    const w = await serverWorld();
    const response = await w.admin.request({
      method: 'POST',
      url: `/admin/repositories/${w.repository.id}/server-test`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = serverConnectionTestSchema.parse(response.json());
    expect(result).toMatchObject({
      ok: true,
      address: { host: '127.0.0.1', port: w.sftp.port, source: 'server' },
      error: null,
    });
    const listed = repositoryListResponseSchema.parse(
      (await w.admin.get('/admin/repositories')).json(),
    );
    expect(listed.repositories[0]).toMatchObject({
      host: 'nas.example',
      serverHost: '127.0.0.1',
      serverPort: w.sftp.port,
      serverAccess: { configured: true, lastTest: { ok: true } },
    });
    // The response holds no key material or server path.
    expect(response.body).not.toContain(w.sftp.directory);
    expect(response.body).not.toMatch(/PRIVATE KEY/);
  });

  it('forgets the last test when the address changes, and reports a failure step by step', async () => {
    const w = await serverWorld();
    await w.admin.request({
      method: 'POST',
      url: `/admin/repositories/${w.repository.id}/server-test`,
    });
    const changed = await w.admin.request({
      method: 'PUT',
      url: `/admin/repositories/${w.repository.id}`,
      payload: {
        name: 'NAS',
        host: 'nas.example',
        port: 22,
        username: 'emucat',
        remoteRoot: '/repo',
        serverHost: '127.0.0.1',
        serverPort: 1,
      },
    });
    expect(changed.json()).toMatchObject({ serverAccess: { lastTest: null } });
    const failed = serverConnectionTestSchema.parse(
      (
        await w.admin.request({
          method: 'POST',
          url: `/admin/repositories/${w.repository.id}/server-test`,
        })
      ).json(),
    );
    expect(failed.ok).toBe(false);
    expect(failed.steps.find((step) => step.ok === false)?.step).toMatch(/host_key|connect/);
  });

  it('is for administrators only', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    const response = await anonymous.request({
      method: 'POST',
      url: `/admin/repositories/${w.repository.id}/server-test`,
    });
    expect([401, 403]).toContain(response.statusCode);
    const unconfigured = serverConnectionTestSchema.parse(
      (
        await w.admin.request({
          method: 'POST',
          url: `/admin/repositories/${w.repository.id}/server-test`,
        })
      ).json(),
    );
    expect(unconfigured.steps[0]).toMatchObject({ step: 'configuration', ok: false });
  });
});
