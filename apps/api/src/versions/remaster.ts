import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  REMASTER_REFUSAL_TEXT,
  remasterPhase,
  type LocalRemasterRequest,
  type PromoteSnapshotRequest,
  type RegistrationState,
  type RemasterCleanupItem,
  type RemasterLineageConflict,
  type RemasterOperation,
  type RemasterPreview,
  type RemasterRefusal,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { VersionDeletionCoordinator } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import {
  describeVersion,
  hasArchiveIntegrity,
  loadGraph,
  oldestFirst,
  versionLabel,
  type GraphVersion,
  type VersionGraph,
} from './graph.js';

/** "Record has changed since last read": with snapshot isolation, a row committed after this read view. */
const ER_CHECKREAD = 1020;
const ER_LOCK_DEADLOCK = 1213;

export interface RemasterLink {
  isOnline(agentId: string): boolean;
  isRegistrationCapable(agentId: string): boolean;
  isVirtualBoxCapable(agentId: string): boolean;
}

/** What the registration coordinator needs from remasters: the commit, and a word once it is durable. */
export interface RemasterCommitter {
  /**
   * Inside the registration's commit transaction, holding its row lock: replaces every version of the VM with
   * the new master. Returns why it cannot, in which case the registration fails and nothing is changed.
   */
  commitIn(
    connection: PoolConnection,
    registration: RowDataPacket,
  ): Promise<{ code: string; message: string } | null>;
  committed(registrationOperationId: string): Promise<void>;
}

/** How a registration's start is dispatched once its row exists. */
export interface RegistrationDispatcher {
  dispatchOperation(agentId: string, operationId: string): Promise<void>;
}

const refuse = (reason: RemasterRefusal, status = 409) =>
  new ApiError(status, reason, REMASTER_REFUSAL_TEXT[reason]);

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

interface LocalSource {
  agentId: string;
  agentName: string;
  sourceName: string;
  machineUuid: string | null;
  localSourceVersionId: string | null;
  contentStatus: 'unverified' | 'verified' | 'modified' | null;
  repositoryId: string;
}

interface Assessment {
  graph: VersionGraph;
  master: GraphVersion;
  promoted: GraphVersion | null;
  retained: GraphVersion[];
  removed: GraphVersion[];
  conflicts: RemasterLineageConflict[];
  source: LocalSource | null;
  refusal: RemasterRefusal | null;
}

interface OperationRow extends RowDataPacket {
  id: string;
  request_id: string;
  kind: RemasterOperation['kind'];
  emulator_type: RemasterOperation['emulatorType'];
  vm_name: string;
  state: RemasterOperation['state'];
  previous_master_version_id: string;
  new_master_version_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  registration_operation_id: string | null;
  registration_state: RegistrationState | null;
  registration_version_id: string | null;
  progress_done_bytes: number | string | null;
  progress_total_bytes: number | string | null;
  retained_count: number;
  removed_count: number;
  removed_bytes: number | string;
  error_code: string | null;
  error_message: string | null;
  requested_by_display_name: string | null;
  created_at: Date;
  committed_at: Date | null;
  finished_at: Date | null;
}

const OPERATION_QUERY = `
  SELECT rm.id, rm.request_id, rm.kind, rm.emulator_type, rm.vm_name, rm.state,
         rm.previous_master_version_id, rm.new_master_version_id, rm.agent_id, a.name AS agent_name,
         rm.registration_operation_id, reg.state AS registration_state,
         reg.version_id AS registration_version_id,
         reg.progress_done_bytes, reg.progress_total_bytes, rm.retained_count, rm.removed_count,
         rm.removed_bytes, rm.error_code, rm.error_message, u.display_name AS requested_by_display_name,
         rm.created_at, rm.committed_at, rm.finished_at
  FROM vm_remaster_operations AS rm
  LEFT JOIN agents AS a ON a.id = rm.agent_id
  LEFT JOIN registration_operations AS reg ON reg.id = rm.registration_operation_id
  LEFT JOIN users AS u ON u.id = rm.requested_by_user_id`;

const toNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

/**
 * Remastering a VM (decision 0048): promoting one of its snapshots to master, or replacing its whole history with
 * a new master exported from a local copy. Neither touches an emulator, a local machine or a local directory. Both
 * end the same way: one transaction makes the new master the only root, tombstones every obsolete version with its
 * exact archive, and the version-deletion machinery of decision 0041 deletes those archives, retrying until each
 * is confirmed gone. A remaster is complete only then.
 */
export class RemasterCoordinator implements RemasterCommitter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly link: RemasterLink,
    private readonly log: FastifyBaseLogger,
    private readonly deletions: VersionDeletionCoordinator,
    private readonly registrations: RegistrationDispatcher,
    private readonly sweepIntervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((error: unknown) => {
        this.log.error({ err: error }, 'Cannot reconcile remasters');
      });
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Assessing.

  /**
   * Everything a remaster decides, from the VM's version graph. With `lock`, inside the remaster's transaction,
   * every read locks: the versions exclusively, everything that refers to them in share mode.
   */
  private async assess(
    executor: Pool | PoolConnection,
    vm: VmIdentity,
    target: { kind: 'snapshot'; versionId: string } | { kind: 'local_copy'; agentId: string },
    lock: boolean,
  ): Promise<Assessment> {
    const graph = await loadGraph(executor, vm, lock);
    const shared = lock ? ' LOCK IN SHARE MODE' : '';
    const master = graph.master;
    if (!master) throw refuse('version_history_inconsistent');
    let refusal: RemasterRefusal | null = graph.consistent ? null : 'version_history_inconsistent';
    const first = (reason: RemasterRefusal) => {
      refusal ??= reason;
    };

    let promoted: GraphVersion | null = null;
    let retained: GraphVersion[] = [];
    let removed: GraphVersion[] = graph.active;
    if (target.kind === 'snapshot') {
      const version = graph.all.find((candidate) => candidate.id === target.versionId);
      if (!version) throw new ApiError(404, 'version_not_found', 'Version not found');
      if (version.deletion !== null) throw refuse('version_deleted');
      if (version.id === master.id) throw refuse('version_is_master');
      promoted = version;
      // By lineage alone: the promoted snapshot's descendants stay, everything else goes.
      const children = new Map<string, GraphVersion[]>();
      for (const candidate of graph.active) {
        if (!candidate.parentVersionId) continue;
        children.set(candidate.parentVersionId, [
          ...(children.get(candidate.parentVersionId) ?? []),
          candidate,
        ]);
      }
      const kept = new Set<string>();
      const pending = [version];
      while (pending.length > 0) {
        const next = pending.pop() as GraphVersion;
        if (kept.has(next.id)) continue;
        kept.add(next.id);
        pending.push(...(children.get(next.id) ?? []));
      }
      retained = graph.active.filter((candidate) => kept.has(candidate.id));
      removed = graph.active.filter((candidate) => !kept.has(candidate.id));
      if (!retained.every(hasArchiveIntegrity)) first('archive_integrity_invalid');
    }

    // One remaster at a time: that is the reason given, whatever else the copy is doing for it.
    const [remasters] = await executor.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_remaster_operations
       WHERE emulator_type = ? AND vm_name = ? AND active_marker = 1 LIMIT 1${shared}`,
      [vm.emulatorType, graph.vmName],
    );
    if (remasters.length > 0) first('remaster_in_progress');

    // The exported copy's own state comes next: for it, a session is "running", not "in use".
    let source: LocalSource | null = null;
    if (target.kind === 'local_copy') {
      const local = await this.localSource(executor, vm, graph, master, target.agentId, lock);
      source = local.source;
      if (local.refusal) first(local.refusal);
    }

    // Nothing else may be changing this VM's history, or using what is about to leave it.
    const [registrations] = await executor.execute<RowDataPacket[]>(
      `SELECT 1 FROM registration_operations
       WHERE emulator_type = ? AND vm_name = ? AND active_marker = 1 LIMIT 1${shared}`,
      [vm.emulatorType, graph.vmName],
    );
    const [virtualbox] = await executor.execute<RowDataPacket[]>(
      `SELECT 1 FROM virtualbox_operations
       WHERE emulator_type = ? AND vm_name = ? AND active_marker = 1 LIMIT 1${shared}`,
      [vm.emulatorType, graph.vmName],
    );
    if (registrations.length > 0 || virtualbox.length > 0) first('operation_in_progress');

    const ids = removed.map((version) => version.id);
    if (ids.length > 0) {
      const list = placeholders(ids);
      // One locking read per table: a lock after a UNION would not cover every part of it.
      const uses: [string, string[]][] = [
        [
          `restore_operations WHERE active_marker = 1
             AND (version_id IN (${list}) OR replaced_version_id IN (${list}))`,
          [...ids, ...ids],
        ],
        [
          `vm_workspaces WHERE active_marker = 1
             AND (base_version_id IN (${list}) OR source_version_id IN (${list}))`,
          [...ids, ...ids],
        ],
        // A clone of another VM reading one of these archives (decision 0052).
        [
          `registration_operations WHERE active_marker = 1 AND clone_source_version_id IN (${list})`,
          ids,
        ],
        [`vm_sessions WHERE active_marker = 1 AND source_version_id IN (${list})`, ids],
        [`vm_verifications WHERE active_marker = 1 AND version_id IN (${list})`, ids],
        [`local_copy_removals WHERE active_marker = 1 AND expected_version_id IN (${list})`, ids],
      ];
      for (const [from, values] of uses) {
        const [rows] = await executor.execute<RowDataPacket[]>(
          `SELECT 1 FROM ${from} LIMIT 1${shared}`,
          values,
        );
        if (rows.length > 0) first('version_in_use');
      }
    }

    // Copies that come from a version about to be removed keep their files, and their known lineage. They are
    // reported, never relabelled: the source being exported is the one copy whose lineage the commit moves.
    const conflicts: RemasterLineageConflict[] = [];
    if (ids.length > 0) {
      const [copies] = await executor.execute<RowDataPacket[]>(
        `SELECT s.agent_id, s.local_source_version_id FROM agent_vm_state AS s
         WHERE s.emulator_type = ? AND s.vm_name = ? AND s.execution_state <> 'absent'
           AND s.local_source_version_id IN (${placeholders(ids)})${shared}`,
        [vm.emulatorType, graph.vmName, ...ids],
      );
      const holders = copies.filter(
        (copy) => target.kind !== 'local_copy' || copy.agent_id !== target.agentId,
      );
      if (holders.length > 0) {
        // Agents are read without a lock: a restore holds its agent's row while it waits for a version.
        const [agents] = await this.pool.execute<RowDataPacket[]>(
          `SELECT id, name FROM agents
           WHERE revoked_at IS NULL AND id IN (${placeholders(holders)}) ORDER BY name`,
          holders.map((copy) => copy.agent_id as string),
        );
        for (const agent of agents) {
          const copy = holders.find((candidate) => candidate.agent_id === agent.id);
          const version = graph.all.find(
            (candidate) => candidate.id === copy?.local_source_version_id,
          );
          if (!version) continue;
          conflicts.push({
            agentId: agent.id as string,
            agentName: agent.name as string,
            versionId: version.id,
            versionLabel: versionLabel(version),
          });
        }
      }
    }
    return { graph, master, promoted, retained, removed, conflicts, source, refusal };
  }

  /** The local copy a remaster would export, and why it cannot be, if it cannot. */
  private async localSource(
    executor: Pool | PoolConnection,
    vm: VmIdentity,
    graph: VersionGraph,
    master: GraphVersion,
    agentId: string,
    lock: boolean,
  ): Promise<{ source: LocalSource | null; refusal: RemasterRefusal | null }> {
    const shared = lock ? ' LOCK IN SHARE MODE' : '';
    const [agents] = await this.pool.execute<RowDataPacket[]>(
      'SELECT name, revoked_at, paired_at FROM agents WHERE id = ?',
      [agentId],
    );
    const agent = agents[0];
    if (!agent || !agent.paired_at) throw new ApiError(404, 'agent_not_found', 'Agent not found');
    let refusal: RemasterRefusal | null = null;
    const first = (reason: RemasterRefusal) => {
      refusal ??= reason;
    };
    const virtualbox = vm.emulatorType === 'virtualbox';
    if (agent.revoked_at) first('agent_cannot_remaster');
    if (!this.link.isOnline(agentId)) first('agent_offline');
    else if (
      !this.link.isRegistrationCapable(agentId) ||
      (virtualbox && !this.link.isVirtualBoxCapable(agentId))
    ) {
      first('agent_cannot_remaster');
    }

    // The emulator may be running, `unknown` included: an export would describe no single moment of it.
    const [sessions] = await executor.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_sessions
       WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1 LIMIT 1${shared}`,
      [agentId, vm.emulatorType, graph.vmName],
    );
    if (sessions.length > 0) first('vm_running');
    // The agent has one operation slot; an export waits for nothing.
    const busy: [string, string[]][] = [
      ['restore_operations WHERE agent_id = ? AND active_marker = 1', [agentId]],
      ['vm_verifications WHERE agent_id = ? AND active_marker = 1', [agentId]],
      ['registration_operations WHERE agent_id = ? AND active_marker = 1', [agentId]],
      ['local_copy_removals WHERE agent_id = ? AND active_marker = 1', [agentId]],
      ['virtualbox_operations WHERE agent_id = ? AND active_marker = 1', [agentId]],
    ];
    for (const [from, values] of busy) {
      const [rows] = await executor.execute<RowDataPacket[]>(
        `SELECT 1 FROM ${from} LIMIT 1${shared}`,
        values,
      );
      if (rows.length > 0) first('operation_in_progress');
    }

    const [states] = await executor.execute<RowDataPacket[]>(
      `SELECT execution_state, local_source_version_id, content_status FROM agent_vm_state
       WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?${shared}`,
      [agentId, vm.emulatorType, graph.vmName],
    );
    const state = states[0];
    let sourceName = graph.vmName;
    let machineUuid: string | null = null;
    if (virtualbox) {
      // The linked machine, by its UUID. Its link is the administrator's (decision 0046), and stays as it is.
      const [sources] = await executor.execute<RowDataPacket[]>(
        `SELECT machine_uuid, display_name, state, present, is_accessible FROM virtualbox_sources
         WHERE emulator_type = 'virtualbox' AND vm_name = ? AND agent_id = ?${shared}`,
        [graph.vmName, agentId],
      );
      const machine = sources[0];
      if (!machine || !machine.present) {
        first('local_source_missing');
      } else {
        machineUuid = machine.machine_uuid as string;
        sourceName = (machine.display_name as string | null) ?? graph.vmName;
        if (!machine.is_accessible || machine.state !== 'powered_off')
          first('source_not_exportable');
      }
    } else if (!state || state.execution_state === 'absent') {
      first('local_source_missing');
    } else if (state.execution_state !== 'idle') {
      // `unknown` means discovery saw it vanish and come back, `error` that an operation left it unsafe, and the
      // rest that something is working on it. Only an idle copy is exported.
      first('source_not_exportable');
    }

    // The new master goes where the history is, so that a VM's versions never scatter.
    const [repositories] = await executor.execute<RowDataPacket[]>(
      `SELECT r.enabled, ar.agent_id AS authorized FROM repositories AS r
       LEFT JOIN agent_repositories AS ar ON ar.repository_id = r.id AND ar.agent_id = ?
       WHERE r.id = ?${shared}`,
      [agentId, master.repositoryId],
    );
    if (!repositories[0]?.enabled || !repositories[0]?.authorized) first('repository_unavailable');

    return {
      source: {
        agentId,
        agentName: agent.name as string,
        sourceName,
        machineUuid,
        localSourceVersionId: (state?.local_source_version_id as string | null) ?? null,
        contentStatus:
          state && state.execution_state !== 'absent'
            ? (state.content_status as LocalSource['contentStatus'])
            : null,
        repositoryId: master.repositoryId,
      },
      refusal,
    };
  }

  private async preview(
    vm: VmIdentity,
    kind: RemasterPreview['kind'],
    assessment: Assessment,
  ): Promise<RemasterPreview> {
    const { graph, master, promoted, retained, removed, conflicts, source, refusal } = assessment;
    let cleanupAvailable = true;
    const repositories = new Map(removed.map((version) => [version.repositoryId, version]));
    for (const repositoryId of repositories.keys()) {
      if ((await this.deletions.deleterFor(repositoryId, vm.emulatorType)) === null) {
        cleanupAvailable = false;
      }
    }
    return {
      kind,
      emulatorType: vm.emulatorType,
      vmName: graph.vmName,
      revision: graph.revision,
      currentMaster: describeVersion(master),
      promoted: promoted ? describeVersion(promoted) : null,
      retained: oldestFirst(retained).map(describeVersion),
      removed: oldestFirst(removed).map(describeVersion),
      removedBytes: removed.reduce((sum, version) => sum + version.archiveSizeBytes, 0),
      source: source
        ? {
            agentId: source.agentId,
            agentName: source.agentName,
            online: this.link.isOnline(source.agentId),
            sourceName: source.sourceName,
            machineUuid: source.machineUuid,
            localSourceVersionId: source.localSourceVersionId,
            contentStatus: source.contentStatus,
          }
        : null,
      lineageConflicts: conflicts,
      cleanupAvailable,
      refusal: refusal ? { code: refusal, message: REMASTER_REFUSAL_TEXT[refusal] } : null,
    };
  }

  async previewPromotion(vm: VmIdentity, versionId: string): Promise<RemasterPreview> {
    await this.reconcile();
    const assessment = await this.assess(this.pool, vm, { kind: 'snapshot', versionId }, false);
    return this.preview(vm, 'snapshot', assessment);
  }

  async previewLocal(vm: VmIdentity, agentId: string): Promise<RemasterPreview> {
    await this.reconcile();
    const assessment = await this.assess(this.pool, vm, { kind: 'local_copy', agentId }, false);
    return this.preview(vm, 'local_copy', assessment);
  }

  // Promoting a snapshot.

  /**
   * One transaction: the old master is retired, the snapshot becomes the master and loses its parent, every
   * version outside its subtree is tombstoned with its exact archive, and the remaster is recorded as committed.
   * Nothing is exported, uploaded or copied: the snapshot's archive is the new master's. Then the obsolete
   * archives are deleted, by agents, with retries.
   */
  async promote(
    vm: VmIdentity,
    versionId: string,
    input: PromoteSnapshotRequest,
    userId: string,
  ): Promise<RemasterOperation> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, vm, 'snapshot', versionId, null);

    const id = randomUUID();
    let removedIds: string[];
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockVm(connection, vm);
      const assessment = await this.assess(connection, vm, { kind: 'snapshot', versionId }, true);
      const { graph, master, removed, retained, conflicts } = assessment;
      const promoted = assessment.promoted as GraphVersion;
      if (graph.revision !== input.expectedRevision) throw refuse('version_history_stale');
      if (assessment.refusal) throw refuse(assessment.refusal);
      if (conflicts.length > 0 && input.acknowledgeLineageConflicts !== true) {
        throw refuse('source_lineage_conflict');
      }
      await connection.execute(
        `INSERT INTO vm_remaster_operations
           (id, request_id, emulator_type, vm_name, kind, state, requested_by_user_id, expected_revision,
            previous_master_version_id, new_master_version_id, retained_count, removed_count,
            removed_bytes, committed_at)
         VALUES (?, ?, ?, ?, 'snapshot', 'cleaning', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [
          id,
          input.requestId,
          vm.emulatorType,
          graph.vmName,
          userId,
          input.expectedRevision,
          master.id,
          promoted.id,
          retained.length,
          removed.length,
          removed.reduce((sum, version) => sum + version.archiveSizeBytes, 0),
        ],
      );
      // The old master first, so that the one-master index never sees two.
      await connection.execute(
        'UPDATE vm_versions SET retired_at = UTC_TIMESTAMP(3) WHERE id = ?',
        [master.id],
      );
      await connection.execute(
        `UPDATE vm_versions
         SET kind = 'master', parent_version_id = NULL, promoted_at = UTC_TIMESTAMP(3),
             promoted_from_parent_version_id = ?
         WHERE id = ?`,
        [promoted.parentVersionId, promoted.id],
      );
      await this.tombstone(connection, id, removed, userId);
      await connection.commit();
      removedIds = removed.map((version) => version.id);
    } catch (error) {
      await connection.rollback();
      const translated = translate(error);
      if (translated === 'duplicate') {
        const winner = await this.byRequest(input.requestId);
        if (winner) return this.sameRequest(winner, vm, 'snapshot', versionId, null);
        throw refuse('remaster_in_progress');
      }
      throw translated;
    } finally {
      connection.release();
    }
    this.log.info({ remasterId: id, vmName: vm.vmName, versionId }, 'Snapshot promoted to master');
    await this.deletions.dispatch(removedIds);
    return this.require(id);
  }

  // Remastering from a local copy.

  /**
   * Records the remaster and its registration, in one transaction that takes every version's lock exclusively:
   * from then on, until it commits or fails, no version of this VM gains a new reference. Nothing in the catalog
   * changes until the agent has exported, uploaded, verified and published the new master's archive, and the
   * registration's commit replaces the history.
   */
  async createLocal(
    vm: VmIdentity,
    input: LocalRemasterRequest,
    userId: string,
  ): Promise<RemasterOperation> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, vm, 'local_copy', null, input.agentId);
    await this.reconcile();

    const id = randomUUID();
    const registrationId = randomUUID();
    const versionId = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Shared, as a registration's: restores and launches take it exclusively, so none start alongside.
      await connection.execute('SELECT id FROM agents WHERE id = ? LOCK IN SHARE MODE', [
        input.agentId,
      ]);
      await this.lockVm(connection, vm);
      const assessment = await this.assess(
        connection,
        vm,
        { kind: 'local_copy', agentId: input.agentId },
        true,
      );
      const { graph, master, removed, conflicts } = assessment;
      const source = assessment.source as LocalSource;
      if (graph.revision !== input.expectedRevision) throw refuse('version_history_stale');
      if (input.confirmVmName !== graph.vmName) throw refuse('confirmation_mismatch', 400);
      if (assessment.refusal) throw refuse(assessment.refusal);
      if (conflicts.length > 0 && input.acknowledgeLineageConflicts !== true) {
        throw refuse('source_lineage_conflict');
      }
      await connection.execute(
        `INSERT INTO registration_operations
           (id, agent_id, repository_id, requested_by_user_id, emulator_type, vm_name, virtualbox_uuid,
            mode, version_id, archive_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'remaster', ?, ?)`,
        [
          registrationId,
          input.agentId,
          source.repositoryId,
          userId,
          vm.emulatorType,
          graph.vmName,
          source.machineUuid,
          versionId,
          archiveObjectKey({ emulatorType: vm.emulatorType, vmName: graph.vmName }, versionId),
        ],
      );
      await connection.execute(
        `INSERT INTO vm_remaster_operations
           (id, request_id, emulator_type, vm_name, kind, state, requested_by_user_id, expected_revision,
            previous_master_version_id, agent_id, registration_operation_id, retained_count,
            removed_count, removed_bytes)
         VALUES (?, ?, ?, ?, 'local_copy', 'exporting', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          input.requestId,
          vm.emulatorType,
          graph.vmName,
          userId,
          input.expectedRevision,
          master.id,
          input.agentId,
          registrationId,
          removed.length,
          removed.reduce((sum, version) => sum + version.archiveSizeBytes, 0),
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      const translated = translate(error);
      if (translated === 'duplicate') {
        const winner = await this.byRequest(input.requestId);
        if (winner) return this.sameRequest(winner, vm, 'local_copy', null, input.agentId);
        throw refuse('operation_in_progress');
      }
      throw translated;
    } finally {
      connection.release();
    }
    this.log.info(
      { remasterId: id, vmName: vm.vmName, agentId: input.agentId, registrationId },
      'Remaster from a local copy requested',
    );
    // If this cannot be delivered, the registration stays queued and goes out when the agent reconnects.
    await this.registrations.dispatchOperation(input.agentId, registrationId);
    return this.require(id);
  }

  /** Part of the registration's commit transaction, which holds the registration's row lock. */
  async commitIn(
    connection: PoolConnection,
    registration: RowDataPacket,
  ): Promise<{ code: string; message: string } | null> {
    const [remasters] = await connection.execute<RowDataPacket[]>(
      `SELECT id, state, requested_by_user_id FROM vm_remaster_operations
       WHERE registration_operation_id = ? FOR UPDATE`,
      [registration.id],
    );
    const remaster = remasters[0];
    if (!remaster || remaster.state !== 'exporting') {
      return { code: 'remaster_not_active', message: 'This remaster is no longer in progress.' };
    }
    const vm: VmIdentity = {
      emulatorType: registration.emulator_type as VmIdentity['emulatorType'],
      vmName: registration.vm_name as string,
    };
    const size = Number(registration.archive_size_bytes);
    if (!(size > 0) || !/^[0-9a-f]{64}$/.test(String(registration.archive_sha256))) {
      return {
        code: 'archive_integrity_invalid',
        message: REMASTER_REFUSAL_TEXT.archive_integrity_invalid,
      };
    }
    const graph = await loadGraph(connection, vm, true);
    const master = graph.master;
    if (!master) {
      return {
        code: 'version_history_inconsistent',
        message: REMASTER_REFUSAL_TEXT.version_history_inconsistent,
      };
    }
    // Everything live is replaced: leaf deletions already under way keep their own tombstones.
    const removed = graph.active;
    await connection.execute('UPDATE vm_versions SET retired_at = UTC_TIMESTAMP(3) WHERE id = ?', [
      master.id,
    ]);
    await connection.execute(
      `INSERT INTO vm_versions
         (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
          archive_size_bytes, created_by_agent_id, created_by_user_id)
       VALUES (?, ?, ?, 'master', ?, ?, ?, ?, ?, ?)`,
      [
        registration.version_id,
        vm.emulatorType,
        graph.vmName,
        registration.repository_id,
        registration.archive_key,
        registration.archive_sha256,
        registration.archive_size_bytes,
        registration.agent_id,
        registration.requested_by_user_id,
      ],
    );
    await this.tombstone(
      connection,
      remaster.id as string,
      removed,
      (remaster.requested_by_user_id as string | null) ?? null,
    );
    // The exported copy is now a copy of the new master; its native association, directory or machine, stays.
    if (vm.emulatorType === 'virtualbox') {
      // Nothing verifies a VirtualBox machine against an OVA (decision 0045).
      await connection.execute(
        `INSERT INTO agent_vm_state
           (agent_id, emulator_type, vm_name, local_source_version_id, execution_state, content_status)
         VALUES (?, 'virtualbox', ?, ?, 'idle', 'unverified')
         ON DUPLICATE KEY UPDATE local_source_version_id = VALUES(local_source_version_id),
           content_status = 'unverified'`,
        [registration.agent_id, graph.vmName, registration.version_id],
      );
    } else {
      await connection.execute(
        `INSERT INTO agent_vm_state
           (agent_id, emulator_type, vm_name, local_source_version_id, execution_state,
            content_status, last_verified_at, last_verified_sha256)
         VALUES (?, ?, ?, ?, 'idle', 'verified', UTC_TIMESTAMP(3), ?)
         ON DUPLICATE KEY UPDATE local_source_version_id = VALUES(local_source_version_id),
           execution_state = 'idle', content_status = 'verified',
           last_verified_at = VALUES(last_verified_at),
           last_verified_sha256 = VALUES(last_verified_sha256)`,
        [
          registration.agent_id,
          vm.emulatorType,
          graph.vmName,
          registration.version_id,
          registration.manifest_sha256,
        ],
      );
    }
    await connection.execute(
      `UPDATE vm_remaster_operations
       SET state = 'cleaning', new_master_version_id = ?, committed_at = UTC_TIMESTAMP(3),
           removed_count = ?, removed_bytes = ?
       WHERE id = ?`,
      [
        registration.version_id,
        removed.length,
        removed.reduce((sum, version) => sum + version.archiveSizeBytes, 0),
        remaster.id,
      ],
    );
    return null;
  }

  /** After the commit is durable: the obsolete archives go. */
  async committed(registrationOperationId: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT d.version_id FROM vm_version_deletions AS d
       JOIN vm_remaster_operations AS rm ON rm.id = d.remaster_operation_id
       WHERE rm.registration_operation_id = ? AND d.state = 'deleting'`,
      [registrationOperationId],
    );
    this.log.info({ registrationOperationId }, 'New master committed by a remaster');
    await this.deletions.dispatch(rows.map((row) => row.version_id as string));
  }

  /** The deletion manifest: one tombstone per obsolete version, with its archive as it was registered. */
  private async tombstone(
    connection: PoolConnection,
    remasterId: string,
    versions: readonly GraphVersion[],
    userId: string | null,
  ): Promise<void> {
    for (const version of versions) {
      await connection.execute(
        `INSERT INTO vm_version_deletions
           (version_id, emulator_type, vm_name, request_id, remaster_operation_id, requested_by_user_id,
            repository_id, archive_key, archive_sha256, archive_size_bytes, next_retry_at)
         SELECT id, emulator_type, vm_name, ?, ?, ?, repository_id, archive_key, archive_sha256,
                archive_size_bytes, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
         FROM vm_versions WHERE id = ?`,
        // The first attempt is sent right after the commit; the sweep only takes over if it never is.
        [randomUUID(), remasterId, userId, this.deletions.firstRetryDelayMs * 1000, version.id],
      );
    }
  }

  private async lockVm(connection: PoolConnection, vm: VmIdentity): Promise<void> {
    const [vms] = await connection.execute<RowDataPacket[]>(
      'SELECT vm_name FROM virtual_machines WHERE emulator_type = ? AND vm_name = ? FOR UPDATE',
      [vm.emulatorType, vm.vmName],
    );
    if (vms.length === 0) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
  }

  // Reading, retrying and reconciling.

  /**
   * Settles what a restart, a lost agent or a cancellation left: an export whose registration ended without a
   * commit failed, and changed nothing; a cleanup whose every archive is confirmed gone is complete. Idempotent.
   */
  async reconcile(): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_remaster_operations AS rm
       JOIN registration_operations AS reg ON reg.id = rm.registration_operation_id
       SET rm.state = 'failed', rm.finished_at = UTC_TIMESTAMP(3),
           rm.error_code = COALESCE(reg.error_code, 'export_failed'),
           rm.error_message = COALESCE(reg.error_message, 'The export ended without a new master.')
       WHERE rm.state = 'exporting' AND reg.state IN ('failed', 'cancelled')`,
    );
    await this.pool.execute(
      `UPDATE vm_remaster_operations AS rm
       SET rm.state = 'completed', rm.finished_at = UTC_TIMESTAMP(3)
       WHERE rm.state = 'cleaning'
         AND NOT EXISTS (SELECT 1 FROM vm_version_deletions AS d
                         WHERE d.remaster_operation_id = rm.id AND d.state <> 'deleted')`,
    );
  }

  private async byRequest(requestId: string): Promise<OperationRow | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE rm.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private async sameRequest(
    row: OperationRow,
    vm: VmIdentity,
    kind: RemasterOperation['kind'],
    versionId: string | null,
    agentId: string | null,
  ): Promise<RemasterOperation> {
    if (
      row.kind !== kind ||
      row.emulator_type !== vm.emulatorType ||
      row.vm_name.toLowerCase() !== vm.vmName.toLowerCase() ||
      (versionId !== null && row.new_master_version_id !== versionId) ||
      (agentId !== null && row.agent_id !== agentId)
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another operation.');
    }
    return this.toOperation(row);
  }

  private async toOperation(row: OperationRow): Promise<RemasterOperation> {
    const [items] = await this.pool.execute<RowDataPacket[]>(
      `SELECT d.version_id, d.state, d.archive_outcome, d.attempts, d.error_code, d.error_message,
              version.kind, version.snapshot_name, version.title
       FROM vm_version_deletions AS d
       JOIN vm_versions AS version ON version.id = d.version_id
       WHERE d.remaster_operation_id = ?
       ORDER BY version.created_at, version.id`,
      [row.id],
    );
    const cleanup: RemasterCleanupItem[] = items.map((item) => ({
      versionId: item.version_id as string,
      label: versionLabel({
        id: item.version_id as string,
        kind: item.kind as GraphVersion['kind'],
        snapshotName: (item.snapshot_name as string | null) ?? null,
        title: (item.title as string | null) ?? null,
      }),
      state: item.state as RemasterCleanupItem['state'],
      archiveOutcome: (item.archive_outcome as RemasterCleanupItem['archiveOutcome']) ?? null,
      attempts: Number(item.attempts),
      error: item.error_code
        ? { code: item.error_code as string, message: (item.error_message as string | null) ?? '' }
        : null,
    }));
    const deleted = cleanup.filter((item) => item.state === 'deleted').length;
    const committed = row.state === 'cleaning' || row.state === 'completed';
    return {
      id: row.id,
      kind: row.kind,
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      state: row.state,
      phase: remasterPhase(row.state, row.registration_state),
      previousMasterVersionId: row.previous_master_version_id,
      newMasterVersionId: row.new_master_version_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      registrationOperationId: row.registration_operation_id,
      progress:
        row.state === 'exporting'
          ? {
              doneBytes: toNumber(row.progress_done_bytes),
              totalBytes: toNumber(row.progress_total_bytes),
            }
          : { doneBytes: null, totalBytes: null },
      retainedCount: Number(row.retained_count),
      removedCount: Number(row.removed_count),
      removedBytes: Number(row.removed_bytes),
      cleanup: {
        total: cleanup.length,
        deleted,
        complete: committed && deleted === cleanup.length,
        items: cleanup,
      },
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
      requestedByDisplayName: row.requested_by_display_name,
      createdAt: row.created_at.toISOString(),
      committedAt: row.committed_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }

  async get(id: string): Promise<RemasterOperation | null> {
    await this.reconcile();
    const [rows] = await this.pool.execute<OperationRow[]>(`${OPERATION_QUERY} WHERE rm.id = ?`, [
      id,
    ]);
    return rows[0] ? this.toOperation(rows[0]) : null;
  }

  private async require(id: string): Promise<RemasterOperation> {
    const operation = await this.get(id);
    if (!operation) throw new ApiError(404, 'remaster_not_found', 'Remaster not found');
    return operation;
  }

  async list(vm: VmIdentity): Promise<RemasterOperation[]> {
    await this.reconcile();
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE rm.emulator_type = ? AND rm.vm_name = ?
       ORDER BY rm.created_at DESC, rm.id LIMIT 20`,
      [vm.emulatorType, vm.vmName],
    );
    return Promise.all(rows.map((row) => this.toOperation(row)));
  }

  /** An administrator's retry of the obsolete archives' deletion: sent now, rather than when the delay ends. */
  async retryCleanup(id: string): Promise<RemasterOperation> {
    const operation = await this.require(id);
    if (operation.state !== 'cleaning') {
      throw new ApiError(409, 'cleanup_not_pending', 'This remaster has no cleanup left to do.');
    }
    await this.deletions.dispatch(
      operation.cleanup.items
        .filter((item) => item.state === 'deleting')
        .map((item) => item.versionId),
    );
    return this.require(id);
  }
}

/** A lost race is a stale page or a busy VM, never a server error. */
function translate(error: unknown): unknown {
  const errno = (error as { errno?: number }).errno;
  if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return 'duplicate';
  if (errno === ER_CHECKREAD) return refuse('version_history_stale');
  if (errno === ER_LOCK_DEADLOCK) return refuse('operation_in_progress');
  return error;
}
