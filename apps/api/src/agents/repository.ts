import {
  vmNameKey,
  type AgentHelloPayload,
  type AgentSummary,
  type VmIdentity,
} from '@emucat/contracts';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AgentPresence } from './hub.js';

/**
 * SQL for paired agents. Queries name every column, and never `credential_hash`, so a digest cannot
 * reach a response by accident.
 */

interface AgentRow extends RowDataPacket {
  id: string;
  name: string;
  platform: AgentSummary['platform'];
  architecture: AgentSummary['architecture'];
  agent_version: string | null;
  protocol_version: number | null;
  owner_display_name: string | null;
  paired_at: Date | null;
  last_connected_at: Date | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

const AGENT_QUERY = `
  SELECT a.id, a.name, a.platform, a.architecture, a.agent_version, a.protocol_version,
         u.display_name AS owner_display_name,
         a.paired_at, a.last_connected_at, a.last_seen_at, a.revoked_at
  FROM agents AS a
  LEFT JOIN users AS u ON u.id = a.owner_user_id`;

function toSummary(row: AgentRow, online: boolean): AgentSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    architecture: row.architecture,
    agentVersion: row.agent_version,
    protocolVersion: row.protocol_version,
    pairingStatus: row.revoked_at ? 'revoked' : 'paired',
    online,
    ownerDisplayName: row.owner_display_name,
    pairedAt: row.paired_at?.toISOString() ?? null,
    lastConnectedAt: row.last_connected_at?.toISOString() ?? null,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export async function listAgents(
  pool: Pool,
  isOnline: (agentId: string) => boolean,
): Promise<AgentSummary[]> {
  const [rows] = await pool.execute<AgentRow[]>(
    `${AGENT_QUERY} ORDER BY a.revoked_at IS NOT NULL, a.name, a.id`,
  );
  return rows.map((row) => toSummary(row, isOnline(row.id)));
}

export async function getAgent(
  pool: Pool,
  agentId: string,
  isOnline: (agentId: string) => boolean,
): Promise<AgentSummary | null> {
  const [rows] = await pool.execute<AgentRow[]>(`${AGENT_QUERY} WHERE a.id = ?`, [agentId]);
  return rows[0] ? toSummary(rows[0], isOnline(agentId)) : null;
}

/**
 * Invalidates the credential by removing its digest as well as by marking the agent. The row stays,
 * because catalog history refers to it. Returns whether this call was the one that revoked it.
 */
export async function revokeAgent(pool: Pool, agentId: string): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE agents SET revoked_at = UTC_TIMESTAMP(3), credential_hash = NULL
     WHERE id = ? AND revoked_at IS NULL`,
    [agentId],
  );
  return result.affectedRows > 0;
}

/** Presence in the database. Each write also confirms that the agent has not been revoked. */
export function databaseAgentPresence(pool: Pool): AgentPresence {
  return {
    connected: async (agentId: string, hello: AgentHelloPayload, protocolVersion: number) => {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE agents
         SET last_connected_at = UTC_TIMESTAMP(3), last_seen_at = UTC_TIMESTAMP(3),
             agent_version = ?, platform = ?, architecture = ?, protocol_version = ?
         WHERE id = ? AND revoked_at IS NULL`,
        [hello.agentVersion, hello.platform, hello.architecture, protocolVersion, agentId],
      );
      return result.affectedRows > 0;
    },
    seen: async (agentId: string) => {
      const [result] = await pool.execute<ResultSetHeader>(
        'UPDATE agents SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL',
        [agentId],
      );
      return result.affectedRows > 0;
    },
    disconnected: async (agentId: string) => {
      await pool.execute('UPDATE agents SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?', [
        agentId,
      ]);
    },
  };
}

/** Which of these identities the catalog has. Case-insensitive, like identity itself. */
export async function registeredVmKeys(
  pool: Pool,
  vms: readonly VmIdentity[],
): Promise<Set<string>> {
  if (vms.length === 0) return new Set();
  const tuples = vms.map(() => '(?, ?)').join(', ');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT emulator_type, vm_name FROM virtual_machines WHERE (emulator_type, vm_name) IN (${tuples})`,
    vms.flatMap((vm) => [vm.emulatorType, vm.vmName]),
  );
  return new Set(
    rows.map((row) =>
      vmIdentityKey({ emulatorType: row.emulator_type, vmName: row.vm_name as string }),
    ),
  );
}

export function vmIdentityKey(vm: VmIdentity): string {
  return `${vm.emulatorType}/${vmNameKey(vm.vmName)}`;
}
