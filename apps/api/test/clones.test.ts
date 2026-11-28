/**
 * Cloning a version into a new, independent VM (decisions 0052 and 0055): the request, the server's own work in the
 * repository, the commit, and what the clone does and does not share with its source. The server does everything
 * itself over its own SFTP connection; no agent takes part.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  adminVmDetailSchema,
  archiveObjectKey,
  cloneOptionsResponseSchema,
  registrationOperationSchema,
  type RegistrationOperation,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectZip } from '../src/archives/manifest.js';
import { readCentralDirectory, readSmallEntry, type ZipEntry } from '../src/archives/zip.js';
import { waitFor } from './agent-helpers.js';
import { insertMedia, insertVm, TestClient } from './browser-app.js';
import { closeServers, serverWorld, type ServerWorld } from './server-world.js';
import { closeWorlds, errorCode, world, type World } from './version-world.js';
import { buildZip64Layout } from './archive-sources.js';
import { buildTar, manifestFor, sha256, vmZip } from './zip-builder.js';

afterEach(async () => {
  await closeWorlds();
  await closeServers();
});

const FILES = {
  'disk.qcow2': Buffer.alloc(150_000, 3),
  'vm.json': Buffer.from('{"memory":64}'),
  'firmware/bios.bin': Buffer.from([0x55, 0xaa]),
};

function cloneRequest(
  w: World,
  versionId: string,
  vmName: string,
  overrides: object = {},
  source = 'Win95',
  emulatorType = 'qemu',
) {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/${emulatorType}/${encodeURIComponent(source)}/versions/${versionId}/clone`,
    payload: { vmName, requestId: randomUUID(), ...overrides },
  });
}

async function clone(w: World, versionId: string, vmName: string, overrides: object = {}) {
  const response = await cloneRequest(w, versionId, vmName, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return registrationOperationSchema.parse(response.json());
}

async function operationRow(w: World, operationId: string): Promise<RegistrationOperation> {
  const response = await w.admin.get(`/admin/registrations/${operationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return registrationOperationSchema.parse(response.json());
}

async function finished(w: World, operationId: string): Promise<RegistrationOperation> {
  return waitFor(
    async () => {
      const operation = await operationRow(w, operationId);
      return ['succeeded', 'failed', 'cancelled'].includes(operation.state) ? operation : null;
    },
    'the clone to finish',
    20_000,
  );
}

async function rows(w: World, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await w.context.pool.execute<RowDataPacket[]>(sql, values as string[]);
  return result;
}

/** A world whose Win95 master is a real archive in the repository, registered with its manifest. */
const WIN95 = { emulatorType: 'qemu' as const, vmName: 'Win95' };

async function archivedWorld(
  options: Parameters<typeof serverWorld>[0] = {},
  archive: { zip: Buffer; manifestSha256: string } = vmZip('qemu', 'Win95', FILES),
) {
  const base = await serverWorld(options);
  await insertVm(base.context.pool, { vmName: 'Win95' });
  const { zip, manifestSha256 } = archive;
  const { id, key } = await base.insertVersion(zip, { vm: WIN95 });
  const w: ServerWorld = { ...base, masterId: id };
  await w.context.pool.execute(
    `INSERT INTO registration_operations
       (id, agent_id, repository_id, emulator_type, vm_name, mode, state, version_id, archive_key,
        archive_size_bytes, archive_sha256, manifest_version, manifest_sha256, committed_at, finished_at,
        local_copy)
     VALUES (?, ?, ?, 'qemu', 'Win95', 'copy', 'succeeded', ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(3),
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
  return { w, zip, manifestSha256, key };
}

/** For each central record: how many ZIP64 records its extra field holds, and the IDs of the others. */
function zip64RecordCounts(zip: Buffer, directoryOffset: number) {
  const result: Record<string, { zip64: number; others: number[] }> = {};
  for (let at = directoryOffset; zip.readUInt32LE(at) === 0x02014b50;) {
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const counts = { zip64: 0, others: [] as number[] };
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let field = 0; field + 4 <= extra.length; field += 4 + extra.readUInt16LE(field + 2)) {
      const id = extra.readUInt16LE(field);
      if (id === 0x0001) counts.zip64 += 1;
      else counts.others.push(id);
    }
    result[
      zip
        .subarray(at + 46, at + 46 + nameLength)
        .toString('utf8')
        .replace(/\/$/, '')
    ] = counts;
    at += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

async function insertSnapshot(w: ServerWorld, parentId: string, title: string | null = null) {
  const { id } = await w.insertVersion(
    vmZip('qemu', 'Win95', { ...FILES, 'office.txt': Buffer.from('installed') }).zip,
    {
      vm: WIN95,
      kind: 'snapshot',
      parentVersionId: parentId,
      snapshotName: 'Win95_202601311530',
      title,
    },
  );
  return id;
}

describe('cloning a version on the server', () => {
  it('clones the master into a new, private, independent VM with its own archive, with no agent', async () => {
    const { w } = await archivedWorld();
    // What the source has that a clone must never inherit.
    const tagId = randomUUID();
    await w.context.pool.execute(
      "INSERT INTO tags (id, name, normalized_name) VALUES (?, 'retro', 'retro')",
      [tagId],
    );
    await w.context.pool.execute(
      "INSERT INTO vm_tags (emulator_type, vm_name, tag_id) VALUES ('qemu', 'Win95', ?)",
      [tagId],
    );
    await w.context.pool.execute(
      "UPDATE virtual_machines SET display_name = 'Windows 98', description = 'Source notes' WHERE vm_name = 'Win95'",
    );
    await insertMedia(w.context, { vmName: 'Win95' }, { isMain: true });

    const operation = await clone(w, w.masterId, 'Win95 - Office');
    expect(operation).toMatchObject({
      mode: 'clone',
      emulatorType: 'qemu',
      vmName: 'Win95 - Office',
      agentId: null,
      agentName: null,
      performedBy: 'server',
      cloneSource: { vmName: 'Win95', versionId: w.masterId },
    });
    expect(operation.archiveKey).toBe(
      archiveObjectKey({ emulatorType: 'qemu', vmName: 'Win95 - Office' }, operation.versionId),
    );

    const done = await finished(w, operation.id);
    expect(done.error).toBeNull();
    expect(done).toMatchObject({ state: 'succeeded', localCopy: 'preserved' });
    expect(done.archive).toMatchObject({ format: 'zip', verifiedBy: 'server', fileCount: 3 });

    // The new archive: a complete VM archive whose manifest names the new VM, with the same files.
    const stored = await readFile(join(w.sftp.root, operation.archiveKey));
    expect(sha256(stored)).toBe(done.archive?.sha256);
    const inspected = await inspectZip(
      {
        sizeBytes: stored.length,
        read: async (offset, length) => stored.subarray(offset, offset + length),
      },
      {
        emulatorType: 'qemu',
        vmName: 'Win95 - Office',
        manifestSha256: done.archive?.manifestSha256 ?? null,
      },
    );
    expect(inspected.manifest.entries.map((entry) => entry.path)).toEqual([
      'disk.qcow2',
      'firmware',
      'firmware/bios.bin',
      'vm.json',
    ]);
    // Nothing staged is left, in the repository or on the server.
    expect(readdirSync(join(w.sftp.root, 'archives/.staging'))).toEqual([]);

    const vm = adminVmDetailSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win95%20-%20Office')).json(),
    );
    expect(vm).toMatchObject({
      displayName: null,
      description: null,
      visibility: 'private',
      mediaCount: 0,
      versionCount: 1,
      tags: [],
    });
    expect(vm.clonedFrom).toMatchObject({
      sourceVmName: 'Win95',
      sourceDisplayName: 'Windows 98',
      sourceVersionId: w.masterId,
      sourceVersionKind: 'master',
      clonedByDisplayName: 'The Admin',
      sourceExists: true,
    });
    const versions = await rows(
      w,
      "SELECT kind, parent_version_id, archive_sha256, created_by_agent_id FROM vm_versions WHERE vm_name = 'Win95 - Office'",
    );
    expect(versions).toEqual([
      {
        kind: 'master',
        parent_version_id: null,
        archive_sha256: sha256(stored),
        created_by_agent_id: null,
      },
    ]);
    for (const table of ['agent_vm_state', 'vm_sessions', 'vm_media', 'vm_tags']) {
      expect(
        await rows(w, `SELECT 1 FROM ${table} WHERE vm_name = 'Win95 - Office'`),
        table,
      ).toEqual([]);
    }
    // The source is unchanged, archive included.
    const source = adminVmDetailSchema.parse((await w.admin.get('/admin/vms/qemu/Win95')).json());
    expect(source).toMatchObject({
      displayName: 'Windows 98',
      mediaCount: 1,
      versionCount: 1,
      clonedFrom: null,
    });
    expect(source.tags.map((tag) => tag.name)).toEqual(['retro']);
  });

  it('clones an archive whose entries carry the agent’s two ZIP64 records (F-4)', async () => {
    // Every file as the agent writes one of 3.75 GiB or more: a placeholder ZIP64 record, then the real one.
    // An unrelated extra field (extended timestamp) on the disk must survive the rewrite.
    const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    const { bytes, entries } = manifestFor('qemu', 'Win95', FILES);
    const agentZip = buildZip64Layout(
      entries.map((entry) =>
        entry.name.endsWith('/')
          ? { ...entry, zip64: false as const }
          : {
              ...entry,
              stored: entry.name === 'disk.qcow2',
              zip64: { fields: { uncompressed: true, compressed: true } },
              ...(entry.name === 'disk.qcow2' ? { centralExtra: timestamp } : {}),
            },
      ),
    ).toBuffer();
    const { w } = await archivedWorld({}, { zip: agentZip, manifestSha256: sha256(bytes) });

    const operation = await clone(w, w.masterId, 'Win95 - Big');
    const done = await finished(w, operation.id);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.archive).toMatchObject({ format: 'zip', verifiedBy: 'server', fileCount: 3 });

    const stored = await readFile(join(w.sftp.root, operation.archiveKey));
    const source = {
      sizeBytes: stored.length,
      read: async (o: number, l: number) => stored.subarray(o, o + l),
    };
    const inspected = await inspectZip(source, {
      emulatorType: 'qemu',
      vmName: 'Win95 - Big',
      manifestSha256: done.archive?.manifestSha256 ?? null,
    });
    // Each central record now has exactly one ZIP64 record, with the real values; nothing else was lost.
    const { entries: rewritten } = await readCentralDirectory(source, {
      maxEntries: 100,
      maxDirectoryBytes: 1 << 20,
    });
    expect(zip64RecordCounts(stored, inspected.directoryOffset)).toEqual({
      'disk.qcow2': { zip64: 1, others: [0x5455] },
      firmware: { zip64: 0, others: [] },
      'firmware/bios.bin': { zip64: 1, others: [] },
      'vm.json': { zip64: 1, others: [] },
      '.emucat-manifest.json': { zip64: 0, others: [] },
    });
    for (const [path, data] of Object.entries(FILES)) {
      const entry = rewritten.find((item) => item.name === path);
      expect(entry, path).toBeDefined();
      expect(await readSmallEntry(source, entry as ZipEntry, 1 << 20), path).toEqual(data);
    }
    // The source archive is unchanged.
    const [version] = await rows(w, 'SELECT archive_key FROM vm_versions WHERE id = ?', [
      w.masterId,
    ]);
    expect(sha256(await readFile(join(w.sftp.root, String(version?.archive_key))))).toBe(
      sha256(agentZip),
    );
  });

  it('clones a snapshot from its exact archive, and records which one', async () => {
    const { w } = await archivedWorld();
    const snapshotId = await insertSnapshot(w, w.masterId, 'After Office Installation');
    const operation = await clone(w, snapshotId, 'Win95-Office');
    const done = await finished(w, operation.id);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.archive?.fileCount).toBe(4);
    const vm = adminVmDetailSchema.parse(
      (await w.admin.get('/admin/vms/qemu/Win95-Office')).json(),
    );
    expect(vm.clonedFrom).toMatchObject({
      sourceVersionId: snapshotId,
      sourceVersionKind: 'snapshot',
      sourceSnapshotName: 'Win95_202601311530',
      sourceVersionTitle: 'After Office Installation',
    });
    expect(
      await rows(
        w,
        "SELECT kind, parent_version_id FROM vm_versions WHERE vm_name = 'Win95-Office'",
      ),
    ).toEqual([{ kind: 'master', parent_version_id: null }]);
  });

  it('refuses a source whose bytes or manifest are not the registered ones, and creates nothing', async () => {
    const { w, key } = await archivedWorld();
    // Same size, other bytes.
    const original = await readFile(join(w.sftp.root, key));
    const tampered = Buffer.from(original);
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    await w.put(key, tampered);
    const first = await finished(w, (await clone(w, w.masterId, 'Copy')).id);
    expect(first).toMatchObject({ state: 'failed', error: { code: 'source_archive_invalid' } });

    // The right bytes, and a registration that verified another manifest.
    await w.put(key, original);
    await w.context.pool.execute(
      "UPDATE registration_operations SET manifest_sha256 = ? WHERE mode = 'copy'",
      ['f'.repeat(64)],
    );
    const second = await finished(w, (await clone(w, w.masterId, 'Copy')).id);
    expect(second).toMatchObject({ state: 'failed', error: { code: 'source_archive_invalid' } });

    expect(await rows(w, "SELECT 1 FROM virtual_machines WHERE vm_name = 'Copy'")).toEqual([]);
    expect(await rows(w, 'SELECT 1 FROM vm_clone_provenance')).toEqual([]);
    expect(existsSync(join(w.sftp.root, 'archives/qemu/copy'))).toBe(false);
  });

  it('fails plainly when the source archive is missing', async () => {
    const { w, key } = await archivedWorld();
    const { rmSync } = await import('node:fs');
    rmSync(join(w.sftp.root, key));
    const done = await finished(w, (await clone(w, w.masterId, 'Copy')).id);
    expect(done).toMatchObject({ state: 'failed', error: { code: 'remote_object_missing' } });
    expect(done.recovery).not.toBeNull();
  });

  it('validates the destination name and refuses any collision, ignoring case', async () => {
    const { w } = await archivedWorld();
    for (const name of ['', 'a/b', '..', 'café', 'CON', 'x'.repeat(65), 'Win95_202601010000']) {
      const response = await cloneRequest(w, w.masterId, name);
      expect(response.statusCode, name).toBe(400);
    }
    const same = await cloneRequest(w, w.masterId, 'win98');
    expect(same.statusCode).toBe(409);
    expect(await errorCode(same)).toBe('vm_already_registered');
    const existing = await cloneRequest(w, w.masterId, 'OTHER');
    expect(existing.statusCode).toBe(409);
    expect(await errorCode(existing)).toBe('vm_already_registered');
    expect(await rows(w, "SELECT 1 FROM registration_operations WHERE mode = 'clone'")).toEqual([]);
  });

  it('queues clones beyond the server’s limit, reserves their names, and cancels one that waits', async () => {
    // No slot at all: every clone waits.
    const { w } = await archivedWorld({ transfers: { maxConcurrent: 0 } });
    const operation = await clone(w, w.masterId, 'Copy');
    expect(operation.state).toBe('queued');
    // The name is reserved, ignoring case, for as long as it runs.
    await expect(
      w.context.pool.execute(
        `INSERT INTO registration_operations
           (id, agent_id, repository_id, emulator_type, vm_name, mode, version_id, archive_key)
         VALUES (?, ?, ?, 'qemu', 'COPY', 'copy', ?, 'archives/qemu/copy/x.zip')`,
        [randomUUID(), w.paired.agentId, w.repository.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // Another clone can be queued alongside: the server is not one agent with one slot.
    const second = await clone(w, w.masterId, 'Copy2');
    expect(second.state).toBe('queued');
    // Its source version cannot be deleted meanwhile.
    const refused = await w.admin.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win95/versions/${w.masterId}/deletion`,
      payload: { requestId: randomUUID(), versionId: w.masterId },
    });
    expect(refused.statusCode, refused.body).toBe(409);

    const cancelled = await w.admin.request({
      method: 'POST',
      url: `/admin/registrations/${operation.id}/cancel`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<RegistrationOperation>().state).toBe('cancelled');
    expect(await rows(w, "SELECT 1 FROM virtual_machines WHERE vm_name = 'Copy'")).toEqual([]);
  });

  it('returns the same clone for a repeated request, and refuses the ID for anything else', async () => {
    const { w } = await archivedWorld({ transfers: { maxConcurrent: 0 } });
    const requestId = randomUUID();
    const first = await clone(w, w.masterId, 'Copy', { requestId });
    const again = await cloneRequest(w, w.masterId, 'Copy', { requestId });
    expect(again.statusCode).toBe(202);
    expect(again.json<{ id: string }>().id).toBe(first.id);
    const other = await cloneRequest(w, w.masterId, 'Elsewhere', { requestId });
    expect(other.statusCode).toBe(409);
    expect(await errorCode(other)).toBe('request_id_reused');
  });

  it('ignores an agent named by a browser of the previous release', async () => {
    const { w } = await archivedWorld();
    const operation = await clone(w, w.masterId, 'Copy', { agentId: w.paired.agentId });
    expect(operation.agentId).toBeNull();
    expect((await finished(w, operation.id)).state).toBe('succeeded');
  });

  it(
    'after a restart, runs an interrupted clone again, and gives up on one interrupted too often',
    { timeout: 90_000 },
    async () => {
      const { w, zip } = await archivedWorld({ transfers: { maxConcurrent: 0 } });
      const retried = await clone(w, w.masterId, 'Retried');
      const abandoned = await clone(w, w.masterId, 'Abandoned');
      await w.context.pool.execute(
        "UPDATE registration_operations SET state = 'uploading', server_attempts = 1 WHERE id = ?",
        [retried.id],
      );
      await w.context.pool.execute(
        "UPDATE registration_operations SET state = 'archiving', server_attempts = 3 WHERE id = ?",
        [abandoned.id],
      );
      // A new server process over the same database, staging and repository.
      const { accessFor } = await import('./server-world.js');
      const { DEFAULT_TRANSFER_POLICY } = await import('../src/transfers/policy.js');
      const restarted = await w.context.buildAnother({
        repositoryAccess: accessFor(w.sftp),
        // This one has slots.
        transfers: { ...DEFAULT_TRANSFER_POLICY, stagingPath: join(w.sftp.directory, 'staging') },
      });
      await restarted.ready();
      expect(await finished(w, abandoned.id)).toMatchObject({
        state: 'failed',
        error: { code: 'server_restarted' },
      });
      const done = await finished(w, retried.id);
      expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
      expect(done.archive?.sizeBytes).toBeGreaterThan(zip.length - 100);
    },
  );

  it('stays usable after its source VM and every version of it are gone', async () => {
    const { w } = await archivedWorld();
    const operation = await clone(w, w.masterId, 'Copy');
    expect((await finished(w, operation.id)).state).toBe('succeeded');
    await w.context.pool.execute("DELETE FROM agent_vm_state WHERE vm_name = 'Win95'");
    await w.context.pool.execute("DELETE FROM registration_operations WHERE vm_name = 'Win95'");
    await w.context.pool.execute("DELETE FROM vm_versions WHERE vm_name = 'Win95'");
    await w.context.pool.execute("DELETE FROM virtual_machines WHERE vm_name = 'Win95'");
    const vm = adminVmDetailSchema.parse((await w.admin.get('/admin/vms/qemu/Copy')).json());
    expect(vm.versionCount).toBe(1);
    expect(vm.clonedFrom).toMatchObject({ sourceVmName: 'Win95', sourceExists: false });
    const options = await w.admin.get(
      `/admin/vms/qemu/Copy/versions/${operation.versionId}/clone-options`,
    );
    expect(cloneOptionsResponseSchema.parse(options.json()).refusal).toBeNull();
  });

  it('clones a VirtualBox OVA byte for byte, and links no machine', async () => {
    const { w } = await archivedWorld();
    await insertVm(w.context.pool, { emulatorType: 'virtualbox', vmName: 'XP-Box' });
    const ova = buildTar([
      ['xp.ovf', Buffer.from('<Envelope/>')],
      ['xp-disk001.vmdk', Buffer.alloc(5000, 2)],
    ]);
    const { id: ovaId } = await w.insertVersion(ova, {
      vm: { emulatorType: 'virtualbox', vmName: 'XP-Box' },
    });
    const response = await cloneRequest(w, ovaId, 'XP-Box-Copy', {}, 'XP-Box', 'virtualbox');
    expect(response.statusCode, response.body).toBe(202);
    const operation = registrationOperationSchema.parse(response.json());
    expect(operation.archiveKey).toMatch(/^archives\/virtualbox\/xp-box-copy\/.+\.ova$/);
    const done = await finished(w, operation.id);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.archive).toMatchObject({
      format: 'ova',
      sha256: sha256(ova),
      manifestSha256: null,
    });
    expect((await readFile(join(w.sftp.root, operation.archiveKey))).equals(ova)).toBe(true);
    expect(await rows(w, "SELECT 1 FROM virtualbox_sources WHERE vm_name = 'XP-Box-Copy'")).toEqual(
      [],
    );
  });

  it('says the server does it, and lists no agents', async () => {
    const { w } = await archivedWorld();
    const options = cloneOptionsResponseSchema.parse(
      (await w.admin.get(`/admin/vms/qemu/Win95/versions/${w.masterId}/clone-options`)).json(),
    );
    expect(options).toMatchObject({ refusal: null, performedBy: 'server', agents: [] });
    expect(
      (await w.admin.get(`/admin/vms/qemu/Other/versions/${w.masterId}/clone-options`)).statusCode,
    ).toBe(404);
  });

  it('refuses to clone when the server has no repository connection of its own', async () => {
    const w = await world();
    const options = cloneOptionsResponseSchema.parse(
      (await w.admin.get(`/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`)).json(),
    );
    expect(options.refusal).toBe('server_repository_unavailable');
    const refused = await cloneRequest(w, w.masterId, 'Copy', {}, 'Win98');
    expect(refused.statusCode).toBe(409);
    expect(await errorCode(refused)).toBe('server_repository_unavailable');
  });

  it('is for administrators only', async () => {
    const w = await world();
    const anonymous = new TestClient(w.context.app);
    expect(
      (await anonymous.get(`/admin/vms/qemu/Win98/versions/${w.masterId}/clone-options`))
        .statusCode,
    ).toBe(401);
    const created = await anonymous.request({
      method: 'POST',
      url: `/admin/vms/qemu/Win98/versions/${w.masterId}/clone`,
      payload: { vmName: 'Copy', requestId: randomUUID() },
    });
    expect([401, 403]).toContain(created.statusCode);
    expect(await rows(w, "SELECT 1 FROM registration_operations WHERE mode = 'clone'")).toEqual([]);
  });
});
