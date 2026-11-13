/**
 * A server with a paired, scripted agent, a repository and a registered VM, for the tests of versions,
 * snapshots and remote sessions. See snapshots.test.ts and remote-sessions.test.ts.
 */
import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  registrationOperationSchema,
  versionTreeResponseSchema,
  type RegistrationOperation,
  type RepositorySummary,
  type VersionTreeResponse,
} from '@emucat/contracts';
import type { RowDataPacket } from 'mysql2/promise';
import { expect } from 'vitest';
import type { BrowserDependencies } from '../src/routes/browser.js';
import type { RemoteSessionOptions } from '../src/workspaces/coordinator.js';
import {
  envelope,
  GENEROUS_RATE_LIMITS,
  pairAgent,
  TestAgent,
  wsUrl,
  type PairedAgent,
} from './agent-helpers.js';
import {
  insertVm,
  signedInAdmin,
  startBrowserApp,
  type BrowserTestContext,
  type TestClient,
} from './browser-app.js';

export const SHA = 'a'.repeat(64);
export const MANIFEST_SHA = 'b'.repeat(64);

const worlds: BrowserTestContext[] = [];

/** Closes every world a test file started. Call it from `afterAll`. */
export async function closeWorlds(): Promise<void> {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
}

export interface World {
  context: BrowserTestContext;
  admin: TestClient;
  agent: TestAgent;
  paired: PairedAgent;
  repository: RepositorySummary;
  masterId: string;
}

export interface Capabilities {
  snapshots?: boolean;
  workspaces?: string[] | null;
  modes?: string[];
  /** Whether the agent says it replaces a persistent copy safely. */
  replaceLocal?: boolean;
  /** Whether the agent says it removes a persistent copy, and deletes archives (decision 0041). */
  removeLocal?: boolean;
  deleteArchives?: boolean;
  /** The removals the agent lists as journaled. */
  removals?: { operationId: string; phase: string }[];
}

export async function barrier(agent: TestAgent): Promise<void> {
  agent.send(envelope('agent.heartbeat', {}));
  await agent.next('server.heartbeat_ack');
}

export async function world(
  capabilities: Capabilities = {},
  remoteSessions: Partial<RemoteSessionOptions> = {},
  overrides: Partial<BrowserDependencies> = {},
): Promise<World> {
  const context = await startBrowserApp({
    pairingRateLimits: GENEROUS_RATE_LIMITS,
    remoteSessions,
    ...overrides,
  });
  worlds.push(context);
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const admin = await signedInAdmin(context);
  const paired = await pairAgent(context.app, admin);
  const created = await admin.request({
    method: 'POST',
    url: '/admin/repositories',
    payload: { name: 'NAS', host: 'nas.example', port: 22, username: 'emucat', remoteRoot: '/r' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const repository = created.json<RepositorySummary>();
  const associated = await admin.request({
    method: 'PUT',
    url: `/admin/repositories/${repository.id}/agents/${paired.agentId}`,
  });
  expect(associated.statusCode, associated.body).toBe(200);
  // The restore capabilities must name the repository for a restore to be possible.
  const agent = await TestAgent.connect(wsUrl(context.app), paired.credential);
  await agent.hello();
  const { pool } = context;
  await insertVm(pool, { vmName: 'Win98', visibility: 'public' });
  await insertVm(pool, { vmName: 'Other' });
  const masterId = await insertMaster(context, 'Win98', repository.id, paired.agentId);
  await insertMaster(context, 'Other', repository.id, paired.agentId);
  await pool.execute(
    `INSERT INTO agent_vm_state
       (agent_id, emulator_type, vm_name, local_source_version_id, execution_state, content_status,
        last_verified_at, last_verified_sha256)
     VALUES (?, 'qemu', 'Win98', ?, 'idle', 'verified', UTC_TIMESTAMP(3), ?)`,
    [paired.agentId, masterId, MANIFEST_SHA],
  );
  const w = { context, admin, agent, paired, repository, masterId };
  await resync(w, capabilities);
  return w;
}

/** Sends the three syncs an agent sends after each welcome, naming the repository it has settings for. */
export async function resync(w: World, capabilities: Capabilities = {}): Promise<void> {
  const { agent } = w;
  agent.send(
    envelope('agent.registration_sync', {
      operations: [],
      ...(capabilities.snapshots === false ? {} : { snapshots: true }),
    }),
  );
  agent.send(
    envelope('agent.restore_sync', {
      operations: [],
      capabilities: {
        emulators: [{ emulatorType: 'qemu', basePath: 'C:\\vms\\qemu' }],
        repositoryIds: [w.repository.id],
        cacheMaxBytes: 1_000_000,
        cacheUsedBytes: 0,
        ...(capabilities.replaceLocal === undefined
          ? {}
          : { replaceLocal: capabilities.replaceLocal }),
        ...(capabilities.removeLocal === undefined
          ? {}
          : { removeLocal: capabilities.removeLocal }),
        ...(capabilities.deleteArchives === undefined
          ? {}
          : { deleteArchives: capabilities.deleteArchives }),
      },
      localCopies: [],
      ...(capabilities.workspaces === null ? {} : { workspaces: capabilities.workspaces ?? [] }),
      ...(capabilities.removals ? { removals: capabilities.removals } : {}),
    }),
  );
  agent.send(
    envelope('agent.execution_sync', {
      sessions: [],
      capabilities: {
        emulators: [{ emulatorType: 'qemu', launchable: true, problem: null }],
        modes: capabilities.modes ?? ['local', 'remote_snapshot'],
      },
      verifications: [],
    }),
  );
  await barrier(agent);
}

export async function insertMaster(
  context: BrowserTestContext,
  vmName: string,
  repositoryId: string,
  agentId: string,
): Promise<string> {
  const id = randomUUID();
  await context.pool.execute(
    `INSERT INTO vm_versions
       (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
        archive_size_bytes, created_by_agent_id)
     VALUES (?, 'qemu', ?, 'master', ?, ?, ?, 2048, ?)`,
    [
      id,
      vmName,
      repositoryId,
      archiveObjectKey({ emulatorType: 'qemu', vmName }, id),
      SHA,
      agentId,
    ],
  );
  return id;
}

export async function errorCode(response: { json: <T>() => T }): Promise<string> {
  return response.json<{ error: { code: string } }>().error.code;
}

export function snapshotRequest(w: World, overrides: object = {}, vmName = 'Win98') {
  return w.admin.request({
    method: 'POST',
    url: `/admin/vms/qemu/${vmName}/snapshots`,
    payload: {
      agentId: w.paired.agentId,
      parentVersionId: w.masterId,
      requestId: randomUUID(),
      ...overrides,
    },
  });
}

export async function snapshot(w: World, overrides: object = {}): Promise<RegistrationOperation> {
  const response = await snapshotRequest(w, overrides);
  expect(response.statusCode, response.body).toBe(202);
  return registrationOperationSchema.parse(response.json());
}

export function resultFor(operation: RegistrationOperation, overrides: object = {}) {
  return {
    operationId: operation.id,
    versionId: operation.versionId,
    archiveKey: operation.archiveKey,
    archiveSizeBytes: 4096,
    archiveSha256: 'c'.repeat(64),
    manifestVersion: 1,
    manifestSha256: 'd'.repeat(64),
    fileCount: 4,
    totalUncompressedBytes: 8192,
    ...overrides,
  };
}

/** The agent's side of a successful snapshot: result, committed answer, cleanup report, closed. */
export async function complete(w: World, operation: RegistrationOperation): Promise<void> {
  const request = await w.agent.next('server.registration_request');
  expect(request.payload.operationId).toBe(operation.id);
  w.agent.send(envelope('agent.registration_result', resultFor(operation)));
  const ack = await w.agent.next('server.registration_ack');
  expect(ack.payload).toEqual({
    operationId: operation.id,
    outcome: 'committed',
    versionId: operation.versionId,
    removeLocal: false,
  });
  w.agent.send(
    envelope('agent.registration_cleanup', {
      operationId: operation.id,
      versionId: operation.versionId,
      localCopy: 'preserved',
      code: null,
      message: null,
    }),
  );
  expect((await w.agent.next('server.registration_ack')).payload.outcome).toBe('closed');
}

export async function tree(w: World, vmName = 'Win98'): Promise<VersionTreeResponse> {
  const response = await w.admin.get(`/admin/vms/qemu/${vmName}/versions`);
  expect(response.statusCode, response.body).toBe(200);
  return versionTreeResponseSchema.parse(response.json());
}

export async function localSource(w: World): Promise<string | null> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    `SELECT local_source_version_id FROM agent_vm_state
     WHERE agent_id = ? AND emulator_type = 'qemu' AND vm_name = 'Win98'`,
    [w.paired.agentId],
  );
  return (rows[0]?.local_source_version_id as string | null | undefined) ?? null;
}

export async function versionCount(w: World): Promise<number> {
  const [rows] = await w.context.pool.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM vm_versions WHERE vm_name = 'Win98'",
  );
  return Number(rows[0]?.n);
}

/** Restores a version onto the persistent copy, as an administrator and the agent would. */
export async function restoreVersion(w: World, versionId: string): Promise<void> {
  // A restore never overwrites: the copy has to be gone first, as a discovery would report.
  await w.context.pool.execute(
    `UPDATE agent_vm_state SET execution_state = 'absent', content_status = 'unverified',
       last_verified_at = NULL, last_verified_sha256 = NULL
     WHERE agent_id = ? AND vm_name = 'Win98'`,
    [w.paired.agentId],
  );
  const created = await w.admin.request({
    method: 'POST',
    url: '/admin/restores',
    payload: { agentId: w.paired.agentId, emulatorType: 'qemu', vmName: 'Win98', versionId },
  });
  expect(created.statusCode, created.body).toBe(202);
  const operation = created.json<{ id: string; archive: { sizeBytes: number; sha256: string } }>();
  const request = await w.agent.next('server.restore_request');
  expect(request.payload).toMatchObject({ versionId });
  expect(request.payload).not.toHaveProperty('workspaceId');
  w.agent.send(
    envelope(
      'agent.restore_result',
      restoreResult(operation.id, versionId, operation, undefined, request.payload.manifestSha256),
    ),
  );
  expect((await w.agent.next('server.restore_ack')).payload.outcome).toBe('closed');
}

export function restoreResult(
  operationId: string,
  versionId: string,
  archive: { archive: { sizeBytes: number; sha256: string } },
  directory = 'C:\\vms\\qemu\\Win98',
  manifestSha256: string | null = null,
) {
  return {
    operationId,
    versionId,
    archiveSizeBytes: archive.archive.sizeBytes,
    archiveSha256: archive.archive.sha256,
    manifestVersion: 1,
    manifestSha256: manifestSha256 ?? 'e'.repeat(64),
    fileCount: 3,
    totalUncompressedBytes: 4096,
    localDirectory: directory,
    cache: { hit: false, downloadedBytes: 1, archiveCached: true, totalBytes: 1 },
  };
}

/** The agent's report of a session whose emulator is running. */
export function runningStatus(sessionId: string, vmName = 'Win98') {
  return {
    sessionId,
    emulatorType: 'qemu',
    vmName,
    state: 'running',
    pid: 4242,
    processStartedAt: '2026-11-07T10:00:00.000Z',
    startedAt: '2026-11-07T10:00:00.100Z',
    endedAt: null,
    exitCode: null,
    stopRequested: false,
    gracefulStopAvailable: true,
    code: null,
    message: null,
  };
}

/** The agent's report that the emulator exited, and the server's answer to it. */
export async function stopSession(w: World, status: object): Promise<void> {
  w.agent.send(
    envelope('agent.vm_execution_status', {
      ...status,
      state: 'exited',
      endedAt: '2026-11-07T10:05:00.000Z',
      exitCode: 0,
    }),
  );
  await w.agent.next('server.vm_execution_ack');
}
