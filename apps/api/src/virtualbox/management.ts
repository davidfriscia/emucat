import { randomUUID } from 'node:crypto';
import type {
  ServerMessage,
  VirtualBoxAgentOption,
  VirtualBoxAutoLinkIntent,
  VirtualBoxAutoLinkState,
  VirtualBoxDeleteRequest,
  VirtualBoxImportRequest,
  VirtualBoxLinkRequest,
  VirtualBoxMachine,
  VirtualBoxManagementResponse,
  VirtualBoxOperation,
  VirtualBoxOperationKind,
  VirtualBoxOperationProgressPayload,
  VirtualBoxOperationResultPayload,
  VirtualBoxOperationState,
  VirtualBoxOperationSyncEntry,
  VirtualBoxUnlinkRequest,
  VirtualBoxVmState,
  VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { DiscoveryRecord } from '../agents/discovery.js';
import { lockUsableVersion } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import type { VirtualBoxCoordinator } from './coordinator.js';

/** What management needs from the hub, which owns the sockets. */
export interface VirtualBoxManagementLink {
  isOnline(agentId: string): boolean;
  isVirtualBoxCapable(agentId: string): boolean;
  isVirtualBoxManagementCapable(agentId: string): boolean;
  activeConnectionId(agentId: string): string | null;
  latestDiscovery(agentId: string): DiscoveryRecord | null;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

export interface VirtualBoxManagementPolicy {
  /** A discovery older than this says too little about a machine to link it. */
  discoveryMaxAgeMs: number;
}

const DEFAULT_POLICY: VirtualBoxManagementPolicy = { discoveryMaxAgeMs: 15 * 60 * 1000 };

/** How many operations the VM page lists. */
const HISTORY_LIMIT = 50;

const OPERATION_QUERY = `
  SELECT op.*, a.name AS agent_name, u.display_name AS requested_by_display_name
  FROM virtualbox_operations AS op
  JOIN agents AS a ON a.id = op.agent_id
  LEFT JOIN users AS u ON u.id = op.requested_by_user_id`;

const FAILURE_TEXT = {
  agent_lost_operation:
    'The agent restarted or was replaced and no longer knows about this operation. VirtualBox may or may not have done it: check VirtualBox on the agent before doing anything else.',
  management_unavailable:
    'The agent no longer says that it can import into or delete from VirtualBox. Nothing was sent to it.',
} as const;

const LINK_CHANGED_DURING_IMPORT =
  'The machine linked to this VM changed while the import ran, so the imported machine was not linked. It stays in VirtualBox; link it, or not, from here.';

const isDuplicateEntry = (error: unknown): boolean =>
  (error as { code?: string }).code === 'ER_DUP_ENTRY';

const conflict = (code: string, message: string) => new ApiError(409, code, message);

function strayMachines(value: unknown): VirtualBoxMachine[] {
  if (value === null || value === undefined) return [];
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as VirtualBoxMachine[]) : [];
}

function toOperation(row: RowDataPacket): VirtualBoxOperation {
  const code = row.error_code as string | null;
  return {
    id: row.id as string,
    kind: row.kind as VirtualBoxOperationKind,
    state: row.state as VirtualBoxOperationState,
    stage: (row.stage as VirtualBoxOperation['stage']) ?? null,
    agentId: row.agent_id as string,
    agentName: row.agent_name as string,
    vmName: row.vm_name as string,
    versionId: row.version_id as string | null,
    targetName: row.target_name as string | null,
    machineUuid: row.machine_uuid as string | null,
    machineName: row.machine_name as string | null,
    machineState: row.machine_state as VirtualBoxVmState | null,
    previousMachineUuid: row.previous_machine_uuid as string | null,
    autoLink: row.link_intent
      ? {
          intent: row.link_intent as VirtualBoxAutoLinkIntent,
          state: (row.link_state as VirtualBoxAutoLinkState | null) ?? null,
          linkOperationId: (row.link_operation_id as string | null) ?? null,
          error: row.link_error_code
            ? {
                code: row.link_error_code as string,
                message:
                  (row.link_error_message as string | null) ?? (row.link_error_code as string),
              }
            : null,
        }
      : null,
    strayMachines: strayMachines(row.stray_machines),
    filesRemoved: row.files_removed === null ? null : Boolean(row.files_removed),
    progress: {
      doneBytes: row.progress_bytes === null ? null : Number(row.progress_bytes),
      totalBytes: row.progress_total_bytes === null ? null : Number(row.progress_total_bytes),
    },
    error: code ? { code, message: (row.error_message as string | null) ?? code } : null,
    requestedByDisplayName: row.requested_by_display_name as string | null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
  };
}

/** A link just made, in a transaction not yet committed. */
interface Linked {
  /** Its history row. */
  operationId: string;
  /** The agent the VM was linked through before, which stops watching that machine. */
  previousAgent: string | null;
}

/** A machine named for a link, as its evidence describes it. */
interface Evidence {
  name: string;
  state: VirtualBoxVmState;
  stateChangedAt: string | null;
  /** The version the machine is known to come from: an import's, or none. */
  lineage: string | null;
}

/**
 * Source links, imports and deletions for VirtualBox VMs (decisions 0046 and 0047). A link, relink or unlink is one
 * transaction here; an import or a deletion runs on the agent, which reports how it ended. A machine is linked only
 * when an administrator asks, or when an import they asked for created it: then it is linked to a VM that had none,
 * or replaces the link they explicitly agreed to replace, once the import succeeded and only if that link is still
 * the one they saw. Never by name, and never when an agent comes or goes. Nothing here deletes a machine either,
 * except by sending the one deletion an administrator confirmed, for the one machine they named.
 */
export class VirtualBoxManagement {
  private readonly policy: VirtualBoxManagementPolicy;

  constructor(
    private readonly pool: Pool,
    private readonly link: VirtualBoxManagementLink,
    private readonly coordinator: VirtualBoxCoordinator,
    private readonly log: FastifyBaseLogger,
    policy: Partial<VirtualBoxManagementPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  // What an administrator sees.

  async overview(vm: VmIdentity): Promise<VirtualBoxManagementResponse> {
    await this.requireVirtualBoxVm(vm);
    const source = await this.coordinator.source(vm);
    let sourceVersionId: string | null = null;
    if (source) {
      const [states] = await this.pool.execute<RowDataPacket[]>(
        `SELECT local_source_version_id FROM agent_vm_state
         WHERE agent_id = ? AND emulator_type = 'virtualbox' AND vm_name = ?`,
        [source.agentId, vm.vmName],
      );
      sourceVersionId = (states[0]?.local_source_version_id as string | null | undefined) ?? null;
    }
    const [agents] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, name FROM agents
       WHERE paired_at IS NOT NULL AND revoked_at IS NULL ORDER BY name, id`,
    );
    const options: VirtualBoxAgentOption[] = agents.map((row) => {
      const agentId = row.id as string;
      return {
        agentId,
        agentName: row.name as string,
        online: this.link.isOnline(agentId),
        virtualbox: this.link.isVirtualBoxCapable(agentId),
        management: this.link.isVirtualBoxManagementCapable(agentId),
      };
    });
    const [operations] = await this.pool.execute<RowDataPacket[]>(
      `${OPERATION_QUERY}
       WHERE op.emulator_type = 'virtualbox' AND op.vm_name = ?
       ORDER BY op.created_at DESC, op.id DESC LIMIT ${HISTORY_LIMIT}`,
      [vm.vmName],
    );
    return { source, sourceVersionId, agents: options, operations: operations.map(toOperation) };
  }

  async get(vm: VmIdentity, operationId: string): Promise<VirtualBoxOperation> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `${OPERATION_QUERY} WHERE op.id = ? AND op.emulator_type = 'virtualbox' AND op.vm_name = ?`,
      [operationId, vm.vmName],
    );
    if (!rows[0]) throw new ApiError(404, 'operation_not_found', 'Operation not found');
    return toOperation(rows[0]);
  }

  private async require(operationId: string): Promise<VirtualBoxOperation> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`${OPERATION_QUERY} WHERE op.id = ?`, [
      operationId,
    ]);
    if (!rows[0]) throw new Error(`VirtualBox operation ${operationId} vanished`);
    return toOperation(rows[0]);
  }

  private async requireVirtualBoxVm(vm: VmIdentity): Promise<string> {
    if (vm.emulatorType !== 'virtualbox') {
      throw conflict('not_virtualbox', 'This is available for VirtualBox VMs only.');
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT vm_name FROM virtual_machines WHERE emulator_type = 'virtualbox' AND vm_name = ?`,
      [vm.vmName],
    );
    if (!rows[0]) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
    return rows[0].vm_name as string;
  }

  /** The agent must be online, paired and not revoked, and able to do what is asked of it. */
  private requireAgent(agentId: string, management: boolean): void {
    if (!this.link.isOnline(agentId)) throw conflict('agent_offline', 'This agent is offline.');
    if (!this.link.isVirtualBoxCapable(agentId)) {
      throw conflict(
        'agent_cannot_use_virtualbox',
        'This agent cannot drive VirtualBox: update it, and configure VirtualBox on it.',
      );
    }
    if (management && !this.link.isVirtualBoxManagementCapable(agentId)) {
      throw conflict(
        'agent_cannot_manage_virtualbox',
        'This agent cannot import into or delete from VirtualBox: update it.',
      );
    }
  }

  /**
   * Nothing else may be under way for this VM, or on the agents involved, while its machine changes: no session of
   * it on any agent (an unknown one counts), no registration, snapshot, restore or verification, and no other
   * import or deletion.
   */
  private async requireQuiet(
    connection: PoolConnection,
    vmName: string,
    agentIds: string[],
  ): Promise<void> {
    const [sessions] = await connection.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_sessions
       WHERE emulator_type = 'virtualbox' AND vm_name = ? AND active_marker = 1`,
      [vmName],
    );
    if (sessions.length > 0) {
      throw conflict(
        'vm_running',
        'This VM has a session that is running, or may be. Stop it, and wait for it to end.',
      );
    }
    const [vmBusy] = await connection.execute<RowDataPacket[]>(
      `SELECT 1 FROM registration_operations
         WHERE emulator_type = 'virtualbox' AND vm_name = ? AND active_marker = 1
       UNION ALL SELECT 1 FROM virtualbox_operations
         WHERE emulator_type = 'virtualbox' AND vm_name = ? AND active_marker = 1`,
      [vmName, vmName],
    );
    if (vmBusy.length > 0) {
      throw conflict(
        'operation_in_progress',
        'A registration, snapshot, import or deletion of this VM is under way. Wait for it to finish.',
      );
    }
    for (const agentId of new Set(agentIds)) {
      const [agentBusy] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM registration_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM restore_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM virtualbox_operations WHERE agent_id = ? AND active_marker = 1`,
        [agentId, agentId, agentId, agentId, agentId],
      );
      if (agentBusy.length > 0) {
        throw conflict(
          'operation_in_progress',
          'Another operation is running on this agent. Wait for it to finish.',
        );
      }
    }
  }

  /** The linked machine, locked, so that two changes of link cannot cross. */
  private async lockSource(
    connection: PoolConnection,
    vmName: string,
  ): Promise<RowDataPacket | null> {
    await connection.execute(
      `SELECT vm_name FROM virtual_machines
       WHERE emulator_type = 'virtualbox' AND vm_name = ? FOR UPDATE`,
      [vmName],
    );
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM virtualbox_sources WHERE emulator_type = 'virtualbox' AND vm_name = ? FOR UPDATE`,
      [vmName],
    );
    return rows[0] ?? null;
  }

  /** A linked machine may change only while it is powered off, or no longer there at all. */
  private requireSourceIdle(source: RowDataPacket): void {
    if (source.present === 0) return;
    if (source.state !== 'powered_off') {
      throw conflict(
        'vm_not_powered_off',
        'The linked VirtualBox machine is not powered off. Shut it down (a saved state does not count), and wait until EmuCat sees it powered off.',
      );
    }
  }

  /**
   * What says the machine exists, and what it was: a fresh discovery by the agent's current connection, or an
   * import of this VM that created it.
   */
  private async evidence(
    connection: PoolConnection,
    vmName: string,
    input: VirtualBoxLinkRequest,
  ): Promise<Evidence> {
    const { agentId, machineUuid } = input;
    if (input.importOperationId) {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT machine_name, machine_state, version_id FROM virtualbox_operations
         WHERE id = ? AND kind = 'import' AND state = 'succeeded' AND agent_id = ?
           AND emulator_type = 'virtualbox' AND vm_name = ? AND machine_uuid = ?`,
        [input.importOperationId, agentId, vmName, machineUuid],
      );
      const row = rows[0];
      if (!row) {
        throw conflict(
          'import_not_found',
          'No finished import of this VM on this agent created that machine.',
        );
      }
      const [deleted] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM virtualbox_operations
         WHERE kind = 'delete' AND state = 'succeeded' AND agent_id = ? AND machine_uuid = ?`,
        [agentId, machineUuid],
      );
      if (deleted[0]) {
        throw conflict('machine_already_deleted', 'This machine was deleted from VirtualBox.');
      }
      return {
        name: (row.machine_name as string | null) ?? vmName,
        state: (row.machine_state as VirtualBoxVmState | null) ?? 'unknown',
        stateChangedAt: null,
        lineage: row.version_id as string,
      };
    }
    const discovery = this.link.latestDiscovery(agentId);
    if (
      !discovery ||
      discovery.id !== input.discoveryOperationId ||
      discovery.status !== 'completed' ||
      !discovery.finishedAt ||
      Date.now() - discovery.finishedAt.getTime() > this.policy.discoveryMaxAgeMs ||
      discovery.connectionId !== this.link.activeConnectionId(agentId)
    ) {
      throw conflict(
        'discovery_stale',
        'This discovery is out of date. Run discovery again, and choose the machine from the new report.',
      );
    }
    const machine = discovery.virtualbox?.vms.find((vm) => vm.uuid === machineUuid);
    if (!machine) {
      throw conflict(
        'virtualbox_machine_not_found',
        'The discovery did not list this VirtualBox machine. Run discovery again.',
      );
    }
    if (machine.accessible !== true) {
      throw conflict(
        'virtualbox_machine_inaccessible',
        'VirtualBox cannot read this machine. Fix it in VirtualBox, then run discovery again.',
      );
    }
    return {
      name: machine.name,
      state: machine.state,
      stateChangedAt: machine.stateChangedAt,
      lineage: null,
    };
  }

  // What an administrator does.

  /**
   * Links a machine to the VM, or replaces the machine it is linked to. In one transaction: the old link and its
   * agent state go, the new ones come, and the history row records both. The machine that was linked before is
   * left exactly as it is in VirtualBox.
   */
  async linkMachine(
    vm: VmIdentity,
    input: VirtualBoxLinkRequest,
    userId: string | null,
  ): Promise<VirtualBoxOperation> {
    const vmName = await this.requireVirtualBoxVm(vm);
    const { agentId, machineUuid } = input;
    this.requireAgent(agentId, false);

    let linked: Linked;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      linked = await this.linkIn(connection, vmName, input, userId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        throw conflict(
          'link_changed',
          'This VM or this machine was linked by someone else in the meantime. Reload the page.',
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    const { previousAgent } = linked;
    this.log.info({ vmName, agentId, machineUuid, previousAgent }, 'VirtualBox machine linked');
    await this.rewatch(previousAgent, agentId);
    return this.require(linked.operationId);
  }

  /**
   * The link itself, in the caller's transaction: every check, then the old link and its agent state go, the new
   * ones come, and a history row records both.
   */
  private async linkIn(
    connection: PoolConnection,
    vmName: string,
    input: VirtualBoxLinkRequest,
    userId: string | null,
  ): Promise<Linked> {
    const { agentId, machineUuid } = input;
    const operationId = randomUUID();
    const [agents] = await connection.execute<RowDataPacket[]>(
      'SELECT revoked_at, paired_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
      [agentId],
    );
    if (!agents[0] || !agents[0].paired_at) {
      throw new ApiError(404, 'agent_not_found', 'Agent not found');
    }
    if (agents[0].revoked_at) throw conflict('agent_revoked', 'This agent has been revoked.');

    const current = await this.lockSource(connection, vmName);
    const currentUuid = (current?.machine_uuid as string | undefined) ?? null;
    if (currentUuid !== input.replaceMachineUuid) {
      throw conflict(
        'link_changed',
        'The machine linked to this VM changed since the page was loaded. Reload it, and choose again.',
      );
    }
    if (current && currentUuid === machineUuid && current.agent_id === agentId) {
      throw conflict('already_linked', 'This machine is already linked to this VM.');
    }
    const [elsewhere] = await connection.execute<RowDataPacket[]>(
      'SELECT vm_name FROM virtualbox_sources WHERE agent_id = ? AND machine_uuid = ?',
      [agentId, machineUuid],
    );
    if (elsewhere[0]) {
      throw conflict(
        'virtualbox_already_registered',
        `This VirtualBox machine is already linked, to ${elsewhere[0].vm_name as string}.`,
      );
    }
    if (current) this.requireSourceIdle(current);
    const previousAgent = (current?.agent_id as string | undefined) ?? null;
    await this.requireQuiet(
      connection,
      vmName,
      previousAgent ? [previousAgent, agentId] : [agentId],
    );

    const evidence = await this.evidence(connection, vmName, input);
    if (evidence.state !== 'powered_off') {
      throw conflict(
        'virtualbox_not_powered_off',
        'Only a powered-off VirtualBox machine can be linked. Shut it down (a saved state does not count), run discovery again, and choose it from the new report.',
      );
    }

    if (current) await this.removeSourceIn(connection, vmName, previousAgent as string);
    await connection.execute(
      `INSERT INTO virtualbox_sources
           (emulator_type, vm_name, agent_id, machine_uuid, display_name, state, raw_state,
            state_changed_at, present, is_accessible, observed_at)
         VALUES ('virtualbox', ?, ?, ?, ?, 'powered_off', 'poweroff', ?, TRUE, TRUE, UTC_TIMESTAMP(3))`,
      [
        vmName,
        agentId,
        machineUuid,
        evidence.name,
        evidence.stateChangedAt ? new Date(evidence.stateChangedAt) : null,
      ],
    );
    // A machine imported from a version is that version. One linked from discovery has no known lineage.
    await connection.execute(
      `INSERT INTO agent_vm_state
           (agent_id, emulator_type, vm_name, local_source_version_id, execution_state, content_status)
         VALUES (?, 'virtualbox', ?, ?, 'idle', 'unverified')
         ON DUPLICATE KEY UPDATE local_source_version_id = VALUES(local_source_version_id),
           execution_state = 'idle', content_status = 'unverified'`,
      [agentId, vmName, evidence.lineage],
    );
    await connection.execute(
      `INSERT INTO virtualbox_operations
           (id, request_id, kind, state, agent_id, requested_by_user_id, vm_name, version_id,
            machine_uuid, machine_name, machine_state, previous_machine_uuid, finished_at)
         VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, 'powered_off', ?, UTC_TIMESTAMP(3))`,
      [
        operationId,
        randomUUID(),
        current ? 'relink' : 'link',
        agentId,
        userId,
        vmName,
        evidence.lineage,
        machineUuid,
        evidence.name,
        currentUuid,
      ],
    );
    return { operationId, previousAgent };
  }

  /** Unlinks the VM's machine. The machine stays in VirtualBox as it is; the VM keeps its versions and media. */
  async unlinkMachine(
    vm: VmIdentity,
    input: VirtualBoxUnlinkRequest,
    userId: string | null,
  ): Promise<VirtualBoxOperation> {
    const vmName = await this.requireVirtualBoxVm(vm);
    const operationId = randomUUID();
    let agentId: string;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const current = await this.lockSource(connection, vmName);
      if (!current || current.machine_uuid !== input.machineUuid) {
        throw conflict(
          'link_changed',
          'The machine linked to this VM changed since the page was loaded. Reload it.',
        );
      }
      agentId = current.agent_id as string;
      this.requireSourceIdle(current);
      await this.requireQuiet(connection, vmName, [agentId]);
      await this.removeSourceIn(connection, vmName, agentId);
      await connection.execute(
        `INSERT INTO virtualbox_operations
           (id, request_id, kind, state, agent_id, requested_by_user_id, vm_name, machine_uuid,
            machine_name, machine_state, previous_machine_uuid, finished_at)
         VALUES (?, ?, 'unlink', 'succeeded', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [
          operationId,
          randomUUID(),
          agentId,
          userId,
          vmName,
          current.machine_uuid,
          current.display_name,
          current.state,
          current.machine_uuid,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    this.log.info(
      { vmName, agentId, machineUuid: input.machineUuid },
      'VirtualBox machine unlinked',
    );
    await this.rewatch(agentId, null);
    return this.require(operationId);
  }

  /** The link and what the agent's state says of it. Sessions and history refer to the VM, so they all stay. */
  private async removeSourceIn(
    connection: PoolConnection,
    vmName: string,
    agentId: string,
  ): Promise<void> {
    await connection.execute(
      `DELETE FROM virtualbox_sources WHERE emulator_type = 'virtualbox' AND vm_name = ? AND agent_id = ?`,
      [vmName, agentId],
    );
    await connection.execute(
      `DELETE FROM agent_vm_state WHERE emulator_type = 'virtualbox' AND vm_name = ? AND agent_id = ?`,
      [vmName, agentId],
    );
  }

  private async rewatch(...agentIds: (string | null)[]): Promise<void> {
    for (const agentId of new Set(agentIds)) {
      if (!agentId) continue;
      try {
        await this.coordinator.watch(agentId);
      } catch (error) {
        // The next welcome sends the whole list again.
        this.log.error({ agentId, err: error }, 'Cannot send the VirtualBox watch list');
      }
    }
  }

  private async byRequest(requestId: string): Promise<RowDataPacket | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `${OPERATION_QUERY} WHERE op.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  /**
   * Imports one version's OVA into VirtualBox on an agent, as a new machine. Once it exists it is linked to the VM,
   * if the VM had no machine, or replaces the VM's machine, if the administrator explicitly asked for that; otherwise
   * it is left unlinked. A repeated request finds the operation it created.
   */
  async importVersion(
    vm: VmIdentity,
    versionId: string,
    input: VirtualBoxImportRequest,
    userId: string | null,
  ): Promise<VirtualBoxOperation> {
    const vmName = await this.requireVirtualBoxVm(vm);
    const { agentId, targetName, requestId } = input;
    const repeated = await this.byRequest(requestId);
    if (repeated) {
      if (
        repeated.kind !== 'import' ||
        repeated.agent_id !== agentId ||
        repeated.vm_name.toLowerCase() !== vmName.toLowerCase() ||
        repeated.version_id !== versionId ||
        repeated.target_name !== targetName ||
        (repeated.link_intent === 'relink') !== input.replaceSource
      ) {
        throw conflict('request_id_reused', 'This request ID belongs to another operation.');
      }
      return toOperation(repeated);
    }
    this.requireAgent(agentId, true);

    const operationId = randomUUID();
    let payload: Extract<ServerMessage, { type: 'server.virtualbox_import' }>['payload'];
    let linkIntent: VirtualBoxAutoLinkIntent | null;
    let replaces: string | null;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
        [agentId],
      );
      if (!agents[0] || !agents[0].paired_at) {
        throw new ApiError(404, 'agent_not_found', 'Agent not found');
      }
      if (agents[0].revoked_at) throw conflict('agent_revoked', 'This agent has been revoked.');
      const [versions] = await connection.execute<RowDataPacket[]>(
        `SELECT version.repository_id, version.archive_key, version.archive_size_bytes,
                version.archive_sha256, r.enabled, ar.agent_id AS authorized
         FROM vm_versions AS version
         JOIN repositories AS r ON r.id = version.repository_id
         LEFT JOIN agent_repositories AS ar
           ON ar.repository_id = version.repository_id AND ar.agent_id = ?
         WHERE version.id = ? AND version.emulator_type = 'virtualbox' AND version.vm_name = ?`,
        [agentId, versionId, vmName],
      );
      const version = versions[0];
      if (!version) throw new ApiError(404, 'version_not_found', 'Version not found');
      if (!version.enabled) throw conflict('repository_disabled', 'This repository is disabled.');
      if (!version.authorized) {
        throw conflict(
          'repository_not_authorized',
          'This agent is not associated with the repository that holds this version.',
        );
      }
      await lockUsableVersion(connection, versionId);
      // What becomes of the link is decided now, against the link the administrator saw, and checked again when
      // the import finishes. Replacing a link needs that machine powered off; keeping it needs nothing.
      const current = await this.lockSource(connection, vmName);
      const currentUuid = (current?.machine_uuid as string | undefined) ?? null;
      if (currentUuid !== input.replaceMachineUuid) {
        throw conflict(
          'link_changed',
          'The machine linked to this VM changed since the page was loaded. Reload it, and choose again.',
        );
      }
      if (current && input.replaceSource) this.requireSourceIdle(current);
      linkIntent = current === null ? 'link' : input.replaceSource ? 'relink' : null;
      replaces = linkIntent === 'relink' ? currentUuid : null;
      // An import shares the agent's single operation slot, and a session's machine is not touched by it, but
      // nothing else should be changing this VM while a new machine is made from it.
      await this.requireQuiet(connection, vmName, [agentId]);
      payload = {
        operationId,
        vmName,
        versionId,
        repositoryId: version.repository_id as string,
        archiveKey: version.archive_key as string,
        archiveSizeBytes: Number(version.archive_size_bytes),
        archiveSha256: version.archive_sha256 as string,
        targetName,
      };
      await connection.execute(
        `INSERT INTO virtualbox_operations
           (id, request_id, kind, state, agent_id, requested_by_user_id, vm_name, version_id,
            repository_id, archive_key, archive_size_bytes, archive_sha256, target_name,
            previous_machine_uuid, link_intent, link_state)
         VALUES (?, ?, 'import', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operationId,
          requestId,
          agentId,
          userId,
          vmName,
          versionId,
          payload.repositoryId,
          payload.archiveKey,
          payload.archiveSizeBytes,
          payload.archiveSha256,
          targetName,
          replaces,
          linkIntent,
          linkIntent ? 'pending' : null,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        const winner = await this.byRequest(requestId);
        if (winner && winner.kind === 'import' && winner.version_id === versionId) {
          return toOperation(winner);
        }
        throw conflict(
          'operation_in_progress',
          'Another operation is running on this agent. Wait for it to finish.',
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    this.log.info(
      { operationId, vmName, agentId, versionId, linkIntent, replaces },
      'VirtualBox import requested',
    );
    // If this cannot be delivered, it stays queued and goes out when the agent reconnects.
    this.link.send(agentId, { type: 'server.virtualbox_import', payload });
    return this.require(operationId);
  }

  /**
   * Deletes one machine from VirtualBox, with its files, through `unregistervm --delete`. Only the machine linked
   * to this VM, or one an import of this VM created, and only once the administrator typed its name. The agent
   * checks the name and the state again just before it deletes.
   */
  async deleteMachine(
    vm: VmIdentity,
    input: VirtualBoxDeleteRequest,
    userId: string | null,
  ): Promise<VirtualBoxOperation> {
    const vmName = await this.requireVirtualBoxVm(vm);
    const { agentId, machineUuid, confirmMachineName, requestId } = input;
    const repeated = await this.byRequest(requestId);
    if (repeated) {
      if (
        repeated.kind !== 'delete' ||
        repeated.agent_id !== agentId ||
        repeated.vm_name.toLowerCase() !== vmName.toLowerCase() ||
        repeated.machine_uuid !== machineUuid
      ) {
        throw conflict('request_id_reused', 'This request ID belongs to another operation.');
      }
      return toOperation(repeated);
    }
    this.requireAgent(agentId, true);

    const operationId = randomUUID();
    let machineName: string;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
        [agentId],
      );
      if (!agents[0]) throw new ApiError(404, 'agent_not_found', 'Agent not found');
      if (agents[0].revoked_at) throw conflict('agent_revoked', 'This agent has been revoked.');
      const current = await this.lockSource(connection, vmName);
      const [linkedElsewhere] = await connection.execute<RowDataPacket[]>(
        'SELECT vm_name FROM virtualbox_sources WHERE agent_id = ? AND machine_uuid = ? AND vm_name <> ?',
        [agentId, machineUuid, vmName],
      );
      if (linkedElsewhere[0]) {
        throw conflict(
          'machine_not_associated',
          'This machine is linked to another VM. Delete it from that VM’s page, if at all.',
        );
      }
      let knownName: string;
      let knownState: string | null;
      if (current && current.agent_id === agentId && current.machine_uuid === machineUuid) {
        if (current.present === 0) {
          throw conflict(
            'source_unavailable',
            'VirtualBox no longer lists this machine, so there is nothing to delete. Unlink it instead.',
          );
        }
        knownName = current.display_name as string;
        knownState = current.state as string | null;
      } else {
        // Not linked: only a machine an import of this VM created, which nothing else is linked to.
        const [imports] = await connection.execute<RowDataPacket[]>(
          `SELECT machine_name, machine_state FROM virtualbox_operations
           WHERE kind = 'import' AND state = 'succeeded' AND agent_id = ?
             AND emulator_type = 'virtualbox' AND vm_name = ? AND machine_uuid = ?
           ORDER BY created_at DESC LIMIT 1`,
          [agentId, vmName, machineUuid],
        );
        if (!imports[0]) {
          throw conflict(
            'machine_not_associated',
            'This machine is neither linked to this VM nor created by an import of it, so EmuCat will not delete it.',
          );
        }
        const [deleted] = await connection.execute<RowDataPacket[]>(
          `SELECT 1 FROM virtualbox_operations
           WHERE kind = 'delete' AND state = 'succeeded' AND agent_id = ? AND machine_uuid = ?`,
          [agentId, machineUuid],
        );
        if (deleted[0]) {
          throw conflict('machine_already_deleted', 'This machine was already deleted.');
        }
        knownName = imports[0].machine_name as string;
        knownState = imports[0].machine_state as string | null;
      }
      if (confirmMachineName !== knownName) {
        throw conflict(
          'confirmation_mismatch',
          'The name typed is not this machine’s name in VirtualBox. Type it exactly, including case.',
        );
      }
      if (knownState !== 'powered_off') {
        throw conflict(
          'vm_not_powered_off',
          'Only a powered-off machine can be deleted. Shut it down (a saved state does not count).',
        );
      }
      await this.requireQuiet(connection, vmName, [agentId]);
      machineName = knownName;
      await connection.execute(
        `INSERT INTO virtualbox_operations
           (id, request_id, kind, state, agent_id, requested_by_user_id, vm_name, machine_uuid,
            machine_name, machine_state)
         VALUES (?, ?, 'delete', 'queued', ?, ?, ?, ?, ?, ?)`,
        [operationId, requestId, agentId, userId, vmName, machineUuid, knownName, knownState],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        throw conflict(
          'operation_in_progress',
          'Another operation is running on this agent. Wait for it to finish.',
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    this.log.warn({ operationId, vmName, agentId, machineUuid }, 'VirtualBox deletion requested');
    this.link.send(agentId, {
      type: 'server.virtualbox_delete',
      payload: { operationId, machineUuid, machineName },
    });
    return this.require(operationId);
  }

  // What an agent reports. Its identity comes from its connection, and nowhere else.

  private async rowFor(agentId: string, operationId: string): Promise<RowDataPacket | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `${OPERATION_QUERY} WHERE op.id = ? AND op.agent_id = ? AND op.kind IN ('import', 'delete')`,
      [operationId, agentId],
    );
    return rows[0] ?? null;
  }

  private dispatch(row: RowDataPacket): void {
    const agentId = row.agent_id as string;
    if (row.kind === 'import') {
      this.link.send(agentId, {
        type: 'server.virtualbox_import',
        payload: {
          operationId: row.id as string,
          vmName: row.vm_name as string,
          versionId: row.version_id as string,
          repositoryId: row.repository_id as string,
          archiveKey: row.archive_key as string,
          archiveSizeBytes: Number(row.archive_size_bytes),
          archiveSha256: row.archive_sha256 as string,
          targetName: row.target_name as string,
        },
      });
    } else {
      this.link.send(agentId, {
        type: 'server.virtualbox_delete',
        payload: {
          operationId: row.id as string,
          machineUuid: row.machine_uuid as string,
          machineName: row.machine_name as string,
        },
      });
    }
  }

  private ack(agentId: string, operationId: string): void {
    this.link.send(agentId, { type: 'server.virtualbox_operation_ack', payload: { operationId } });
  }

  private async finish(
    operationId: string,
    state: 'failed' | 'uncertain',
    code: keyof typeof FAILURE_TEXT,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE virtualbox_operations
       SET state = ?, error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3),
           link_state = NULL
       WHERE id = ? AND active_marker = 1`,
      [state, code, FAILURE_TEXT[code], operationId],
    );
  }

  /**
   * After each welcome: what the agent has journals for, or `null` when it cannot import or delete at all. An
   * operation it never received goes out again; one it lost after starting is uncertain, never retried.
   */
  async synced(agentId: string, entries: VirtualBoxOperationSyncEntry[] | null): Promise<void> {
    const listed = new Map((entries ?? []).map((entry) => [entry.operationId, entry.phase]));
    const [active] = await this.pool.execute<RowDataPacket[]>(
      `${OPERATION_QUERY} WHERE op.agent_id = ? AND op.active_marker = 1`,
      [agentId],
    );
    for (const row of active) {
      const id = row.id as string;
      if (listed.has(id)) continue;
      if (entries === null) {
        if (row.state === 'queued') await this.finish(id, 'failed', 'management_unavailable');
        else await this.finish(id, 'uncertain', 'agent_lost_operation');
      } else if (row.state === 'queued') {
        this.dispatch(row);
      } else {
        this.log.warn({ agentId, operationId: id }, 'The agent lost a VirtualBox operation');
        await this.finish(id, 'uncertain', 'agent_lost_operation');
      }
    }
    for (const [operationId, phase] of listed) {
      if (phase !== 'reported') continue;
      // The agent reports it again by itself; an operation unknown here only needs closing.
      const row = await this.rowFor(agentId, operationId);
      if (!row) this.ack(agentId, operationId);
    }
    // An import that succeeded before a restart, whose machine was not linked yet.
    const [unlinked] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM virtualbox_operations
       WHERE agent_id = ? AND kind = 'import' AND state = 'succeeded' AND link_state = 'pending'`,
      [agentId],
    );
    for (const row of unlinked) await this.autoLinkSafely(row.id as string);
  }

  async progress(agentId: string, payload: VirtualBoxOperationProgressPayload): Promise<void> {
    await this.pool.execute(
      `UPDATE virtualbox_operations
       SET state = 'running', stage = ?, progress_bytes = ?, progress_total_bytes = ?
       WHERE id = ? AND agent_id = ? AND active_marker = 1`,
      [payload.stage, payload.doneBytes, payload.totalBytes, payload.operationId, agentId],
    );
  }

  /**
   * How an import or a deletion ended. Recorded once; a repeat only gets its answer again. A deletion of the
   * linked machine that VirtualBox confirmed removes the link, in the same transaction.
   */
  async result(agentId: string, payload: VirtualBoxOperationResultPayload): Promise<void> {
    const { operationId } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row) {
      this.log.warn({ agentId, operationId }, 'A VirtualBox result for an unknown operation');
      this.ack(agentId, operationId);
      return;
    }
    if (row.kind !== payload.kind) {
      this.log.error({ agentId, operationId }, 'A VirtualBox result of the wrong kind');
      return;
    }
    const terminal = row.state === 'succeeded' || row.state === 'failed';
    if (terminal) {
      // Recorded before a restart, perhaps without its link: that is made now, and never the import again.
      if (row.state === 'succeeded' && row.link_state === 'pending') {
        await this.autoLinkSafely(operationId);
      }
      this.ack(agentId, operationId);
      return;
    }
    // An import that finished cleanly names its machine; one with no machine has not succeeded.
    const succeeded =
      payload.outcome === 'succeeded' && (payload.kind === 'delete' || payload.machine !== null);
    const state: VirtualBoxOperationState = succeeded
      ? 'succeeded'
      : payload.outcome === 'succeeded'
        ? 'uncertain'
        : payload.outcome;
    const code = succeeded
      ? null
      : (payload.code ?? (state === 'uncertain' ? 'outcome_uncertain' : 'failed'));
    let rewatch = false;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [locked] = await connection.execute<RowDataPacket[]>(
        'SELECT state FROM virtualbox_operations WHERE id = ? FOR UPDATE',
        [operationId],
      );
      // An uncertain operation can still be settled by its own report; a finished one cannot change.
      if (locked[0]?.state === 'succeeded' || locked[0]?.state === 'failed') {
        await connection.rollback();
        this.ack(agentId, operationId);
        return;
      }
      const machine = payload.kind === 'import' ? payload.machine : null;
      await connection.execute(
        `UPDATE virtualbox_operations
         SET state = ?, error_code = ?, error_message = ?,
             machine_uuid = COALESCE(?, machine_uuid), machine_name = COALESCE(?, machine_name),
             machine_state = COALESCE(?, machine_state), stray_machines = ?, files_removed = ?,
             finished_at = UTC_TIMESTAMP(3),
             link_state = CASE WHEN link_intent IS NOT NULL AND ? THEN 'pending' END
         WHERE id = ?`,
        [
          state,
          code,
          code ? (payload.message ?? code) : null,
          machine?.uuid ?? null,
          machine?.name ?? null,
          machine?.state ?? null,
          payload.strayMachines.length > 0 ? JSON.stringify(payload.strayMachines) : null,
          payload.kind === 'delete' ? payload.filesRemoved : null,
          succeeded && payload.kind === 'import',
          operationId,
        ],
      );
      if (payload.kind === 'delete' && succeeded) {
        // VirtualBox no longer lists the machine. If it was this VM's, the VM has none now; the catalog entry,
        // its versions and its screenshots stay.
        const [sources] = await connection.execute<RowDataPacket[]>(
          `SELECT vm_name FROM virtualbox_sources WHERE agent_id = ? AND machine_uuid = ? FOR UPDATE`,
          [agentId, row.machine_uuid],
        );
        const linked = sources[0]?.vm_name as string | undefined;
        if (linked) {
          await this.removeSourceIn(connection, linked, agentId);
          await connection.execute(
            `INSERT INTO virtualbox_operations
               (id, request_id, kind, state, agent_id, requested_by_user_id, vm_name, machine_uuid,
                machine_name, previous_machine_uuid, finished_at)
             VALUES (?, ?, 'unlink', 'succeeded', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
            [
              randomUUID(),
              randomUUID(),
              agentId,
              row.requested_by_user_id,
              linked,
              row.machine_uuid,
              row.machine_name,
              row.machine_uuid,
            ],
          );
          rewatch = true;
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // No answer: the agent reports again.
      throw error;
    } finally {
      connection.release();
    }
    this.log.info(
      { agentId, operationId, kind: payload.kind, state, code },
      'VirtualBox operation finished',
    );
    if (rewatch) await this.rewatch(agentId);
    // The import is recorded as a success whatever becomes of its link, which is a separate step.
    if (succeeded && payload.kind === 'import') await this.autoLinkSafely(operationId);
    this.ack(agentId, operationId);
  }

  // Linking what an import created.

  /**
   * Retries the link of an import whose link was refused, or is still pending. Only the link: the import is never
   * repeated, and the machine it created is only ever linked, never changed.
   */
  async retryLink(
    vm: VmIdentity,
    operationId: string,
    userId: string | null,
  ): Promise<VirtualBoxOperation> {
    await this.requireVirtualBoxVm(vm);
    const operation = await this.get(vm, operationId);
    if (operation.kind !== 'import' || operation.state !== 'succeeded' || !operation.autoLink) {
      throw conflict(
        'link_not_retryable',
        'Only the link of an import that succeeded, and was to link its machine, can be retried.',
      );
    }
    if (operation.autoLink.state === 'linked') {
      throw conflict('already_linked', 'The imported machine is already linked.');
    }
    this.requireAgent(operation.agentId, false);
    const refusal = await this.autoLink(operationId, true, userId);
    if (refusal) throw refusal;
    return this.get(vm, operationId);
  }

  /** {@link autoLink}, for a caller that cannot answer for it: an unexpected failure leaves the link pending. */
  private async autoLinkSafely(operationId: string): Promise<void> {
    try {
      await this.autoLink(operationId, false);
    } catch (error) {
      this.log.error(
        { operationId, err: error },
        'Cannot link an imported VirtualBox machine; the link stays pending',
      );
    }
  }

  /**
   * Links the machine an import created, as its request said, if every condition of a link still holds: the
   * machine is this agent's and linked to no other VM, the VM is quiet, and the link is still the one the
   * administrator saw when they asked (none, or the powered-off machine they agreed to replace). A refusal is
   * recorded on the import, which stays a success, and is returned; nothing in VirtualBox is changed either way.
   */
  private async autoLink(
    operationId: string,
    retry: boolean,
    userId?: string | null,
  ): Promise<ApiError | null> {
    let linked: Linked | undefined;
    let agentId = '';
    let vmName = '';
    let machineUuid = '';
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM virtualbox_operations WHERE id = ? AND kind = 'import' FOR UPDATE`,
        [operationId],
      );
      const row = rows[0];
      const due =
        row?.state === 'succeeded' &&
        row.link_intent !== null &&
        row.machine_uuid !== null &&
        (row.link_state === 'pending' || (retry && row.link_state === 'failed'));
      if (!row || !due) {
        await connection.rollback();
        return null;
      }
      agentId = row.agent_id as string;
      vmName = row.vm_name as string;
      machineUuid = row.machine_uuid as string;
      const [sources] = await connection.execute<RowDataPacket[]>(
        `SELECT agent_id, machine_uuid FROM virtualbox_sources
         WHERE emulator_type = 'virtualbox' AND vm_name = ?`,
        [vmName],
      );
      if (sources[0]?.agent_id === agentId && sources[0]?.machine_uuid === machineUuid) {
        // Linked by hand meanwhile: there is nothing left to do.
        await connection.execute(
          `UPDATE virtualbox_operations
           SET link_state = 'linked', link_error_code = NULL, link_error_message = NULL WHERE id = ?`,
          [operationId],
        );
        await connection.commit();
        return null;
      }
      linked = await this.linkIn(
        connection,
        vmName,
        {
          agentId,
          machineUuid,
          importOperationId: operationId,
          replaceMachineUuid: (row.previous_machine_uuid as string | null) ?? null,
        },
        userId === undefined ? (row.requested_by_user_id as string | null) : userId,
      );
      await connection.execute(
        `UPDATE virtualbox_operations
         SET link_state = 'linked', link_operation_id = ?, link_error_code = NULL,
             link_error_message = NULL
         WHERE id = ?`,
        [linked.operationId, operationId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      const refusal =
        error instanceof ApiError
          ? error.code === 'link_changed'
            ? conflict('link_changed', LINK_CHANGED_DURING_IMPORT)
            : error
          : isDuplicateEntry(error)
            ? conflict('link_changed', LINK_CHANGED_DURING_IMPORT)
            : null;
      if (!refusal) throw error;
      await this.pool.execute(
        `UPDATE virtualbox_operations SET link_state = 'failed', link_error_code = ?, link_error_message = ?
         WHERE id = ? AND link_state IN ('pending', 'failed')`,
        [refusal.code, refusal.message, operationId],
      );
      this.log.warn(
        { operationId, vmName, agentId, machineUuid, code: refusal.code },
        'The machine an import created was not linked',
      );
      return refusal;
    } finally {
      connection.release();
    }
    if (!linked) return null;
    this.log.info(
      { operationId, vmName, agentId, machineUuid, previousAgent: linked.previousAgent },
      'The machine an import created was linked',
    );
    await this.rewatch(linked.previousAgent, agentId);
    return null;
  }
}
