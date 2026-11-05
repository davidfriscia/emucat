import { randomBytes, randomUUID } from 'node:crypto';
import {
  formatPairingCode,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  type CreatePairingRequest,
  type CreatePairingResponse,
  type PairingPollResponse,
  type PairingRequestReview,
  type PairingRequestStatus,
} from '@emucat/contracts';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashToken } from '../auth/agent-auth.js';
import { withTransaction } from '../db/pool.js';

/**
 * The pairing state machine. Every decision happens in a transaction holding the request's row lock,
 * and compares `expires_at` with the database clock, so approving, rejecting, expiring and polling
 * can race in any order and still leave one outcome and at most one credential.
 */

export interface PairingPolicy {
  /** How long a person has to read the code and approve it. */
  requestTtlSeconds: number;
  /** After approval, how long the agent has at least to collect its credential. */
  collectionTtlSeconds: number;
  pollIntervalSeconds: number;
  /** Unfinished requests allowed at once, so that nobody can fill the table. */
  maxPendingRequests: number;
}

export const DEFAULT_PAIRING_POLICY: PairingPolicy = {
  requestTtlSeconds: 10 * 60,
  collectionTtlSeconds: 2 * 60,
  pollIntervalSeconds: 3,
  maxPendingRequests: 100,
};

/** Dead requests stay this long, so that a slow agent is told what happened to its request. */
const DEAD_REQUEST_RETENTION_HOURS = 24;

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function generateCode(): string {
  // The alphabet has 32 symbols, so five bits map onto it without bias.
  return Array.from(
    randomBytes(PAIRING_CODE_LENGTH),
    (byte) => PAIRING_CODE_ALPHABET[byte & 0x1f],
  ).join('');
}

/** 256 bits. The prefix makes a leaked value recognizable to secret scanners and to people. */
function generatePollingSecret(): string {
  return `emucat_pairing_${randomBytes(32).toString('base64url')}`;
}

function generateCredential(): string {
  return `emucat_agent_${randomBytes(32).toString('base64url')}`;
}

export class PairingCapacityError extends Error {
  override readonly name = 'PairingCapacityError';
}

export async function createPairingRequest(
  pool: Pool,
  request: CreatePairingRequest,
  requestedFrom: string,
  policy: PairingPolicy,
): Promise<CreatePairingResponse> {
  await pool.execute(
    `DELETE FROM agent_pairing_requests WHERE expires_at < UTC_TIMESTAMP(3) - INTERVAL ? HOUR`,
    [DEAD_REQUEST_RETENTION_HOURS],
  );
  const [counts] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS pending FROM agent_pairing_requests
     WHERE status = 'pending' AND expires_at > UTC_TIMESTAMP(3)`,
  );
  if (Number(counts[0]?.pending ?? 0) >= policy.maxPendingRequests) {
    throw new PairingCapacityError();
  }

  // A collision on 40 random bits is unlikely but harmless: the unique key refuses it, and we retry.
  for (let attempt = 0; ; attempt += 1) {
    const id = randomUUID();
    const code = generateCode();
    const pollingSecret = generatePollingSecret();
    try {
      await pool.execute(
        `INSERT INTO agent_pairing_requests
           (id, code_hash, polling_secret_hash, name, platform, architecture, agent_version,
            protocol_version, requested_from, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND)`,
        [
          id,
          hashToken(code),
          hashToken(pollingSecret),
          request.name,
          request.platform,
          request.architecture,
          request.agentVersion,
          request.protocolVersion,
          requestedFrom.slice(0, 64),
          policy.requestTtlSeconds,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === DUPLICATE_ENTRY && attempt < 4) continue;
      throw error;
    }
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT expires_at FROM agent_pairing_requests WHERE id = ?',
      [id],
    );
    return {
      pairingCode: formatPairingCode(code),
      pollingSecret,
      expiresAt: (rows[0]?.expires_at as Date).toISOString(),
      pollIntervalSeconds: policy.pollIntervalSeconds,
    };
  }
}

interface RequestRow extends RowDataPacket {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  name: string;
  platform: PairingRequestReview['platform'];
  architecture: PairingRequestReview['architecture'];
  agent_version: string;
  protocol_version: number;
  requested_from: string;
  created_at: Date;
  expires_at: Date;
  agent_id: string | null;
  decided_at: Date | null;
  decided_by_user_id: string | null;
  is_expired: 0 | 1;
}

const REQUEST_COLUMNS = `id, status, name, platform, architecture, agent_version, protocol_version,
  requested_from, created_at, expires_at, agent_id, decided_at, decided_by_user_id,
  (expires_at <= UTC_TIMESTAMP(3)) AS is_expired`;

function effectiveStatus(row: RequestRow): PairingRequestStatus {
  const open = row.status === 'pending' || row.status === 'approved';
  return open && Number(row.is_expired) === 1 ? 'expired' : row.status;
}

function toReview(row: RequestRow): PairingRequestReview {
  return {
    id: row.id,
    status: effectiveStatus(row),
    name: row.name,
    platform: row.platform,
    architecture: row.architecture,
    agentVersion: row.agent_version,
    protocolVersion: row.protocol_version,
    requestedFrom: row.requested_from,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    agentId: row.agent_id,
  };
}

async function lockByPollingSecret(
  connection: PoolConnection,
  pollingSecret: string,
): Promise<RequestRow | undefined> {
  const [rows] = await connection.execute<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM agent_pairing_requests
     WHERE polling_secret_hash = ? FOR UPDATE`,
    [hashToken(pollingSecret)],
  );
  return rows[0];
}

/**
 * What an agent gets when it polls. The credential is generated, its digest stored, and the request
 * closed in one transaction, so of any number of concurrent polls exactly one receives it, and a
 * failure before the commit leaves the request able to try again. Returns `null` for an unknown secret.
 */
export async function pollPairingRequest(
  pool: Pool,
  pollingSecret: string,
): Promise<PairingPollResponse | null> {
  return withTransaction(pool, async (connection) => {
    const row = await lockByPollingSecret(connection, pollingSecret);
    if (!row) return null;

    const status = effectiveStatus(row);
    switch (status) {
      case 'pending':
        return { status: 'pending', expiresAt: row.expires_at.toISOString() };
      case 'rejected':
        return { status: 'rejected' };
      case 'expired':
        return { status: 'expired' };
      case 'completed':
        return { status: 'consumed' };
      case 'approved':
        break;
    }

    const agentId = randomUUID();
    const credential = generateCredential();
    await connection.execute(
      `INSERT INTO agents
         (id, owner_user_id, name, platform, architecture, agent_version, protocol_version,
          credential_hash, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        row.decided_by_user_id,
        row.name,
        row.platform,
        row.architecture,
        row.agent_version,
        row.protocol_version,
        hashToken(credential),
        row.decided_at,
      ],
    );
    await connection.execute(
      `UPDATE agent_pairing_requests
       SET status = 'completed', completed_at = UTC_TIMESTAMP(3), agent_id = ?
       WHERE id = ?`,
      [agentId, row.id],
    );
    return { status: 'approved', agentId, credential };
  });
}

/** Unknown, malformed and wrong codes are one case, so a wrong guess reveals nothing. */
export async function findPairingRequestByCode(
  pool: Pool,
  input: string,
): Promise<PairingRequestReview | null> {
  const code = normalizePairingCode(input);
  if (!code) return null;
  const [rows] = await pool.execute<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM agent_pairing_requests WHERE code_hash = ?`,
    [hashToken(code)],
  );
  return rows[0] ? toReview(rows[0]) : null;
}

export async function getPairingRequest(
  pool: Pool,
  requestId: string,
): Promise<PairingRequestReview | null> {
  const [rows] = await pool.execute<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM agent_pairing_requests WHERE id = ?`,
    [requestId],
  );
  return rows[0] ? toReview(rows[0]) : null;
}

export async function listPendingPairingRequests(pool: Pool): Promise<PairingRequestReview[]> {
  const [rows] = await pool.execute<RequestRow[]>(
    `SELECT ${REQUEST_COLUMNS} FROM agent_pairing_requests
     WHERE status = 'pending' AND expires_at > UTC_TIMESTAMP(3)
     ORDER BY created_at DESC, id
     LIMIT 100`,
  );
  return rows.map(toReview);
}

export type PairingDecisionOutcome =
  | { outcome: 'decided'; request: PairingRequestReview }
  | { outcome: 'not_found' }
  | { outcome: 'wrong_code' }
  | { outcome: 'expired' }
  | { outcome: 'already_decided'; status: PairingRequestStatus };

/**
 * Approves a request, or rejects it. Approval needs the code as well as the ID: seeing a request in
 * the list does not authorize it, only reading the code from the agent does. Approval also gives the
 * agent a little time to collect, however close to expiring the request was.
 */
export async function decidePairingRequest(
  pool: Pool,
  requestId: string,
  decision: { action: 'approve'; code: string } | { action: 'reject' },
  userId: string,
  policy: PairingPolicy,
): Promise<PairingDecisionOutcome> {
  return withTransaction(pool, async (connection): Promise<PairingDecisionOutcome> => {
    const [rows] = await connection.execute<RequestRow[]>(
      `SELECT ${REQUEST_COLUMNS}, code_hash FROM agent_pairing_requests WHERE id = ? FOR UPDATE`,
      [requestId],
    );
    const row = rows[0] as (RequestRow & { code_hash: Buffer }) | undefined;
    if (!row) return { outcome: 'not_found' };

    if (decision.action === 'approve') {
      const code = normalizePairingCode(decision.code);
      if (!code || !hashToken(code).equals(row.code_hash)) return { outcome: 'wrong_code' };
    }

    const status = effectiveStatus(row);
    if (status === 'expired') return { outcome: 'expired' };
    if (status !== 'pending') return { outcome: 'already_decided', status };

    const [result] = await connection.execute<ResultSetHeader>(
      decision.action === 'approve'
        ? `UPDATE agent_pairing_requests
           SET status = 'approved', decided_at = UTC_TIMESTAMP(3), decided_by_user_id = ?,
               expires_at = GREATEST(expires_at, UTC_TIMESTAMP(3) + INTERVAL ${Number(policy.collectionTtlSeconds)} SECOND)
           WHERE id = ? AND status = 'pending'`
        : `UPDATE agent_pairing_requests
           SET status = 'rejected', decided_at = UTC_TIMESTAMP(3), decided_by_user_id = ?
           WHERE id = ? AND status = 'pending'`,
      [userId, requestId],
    );
    if (result.affectedRows !== 1) throw new Error('A locked pairing request changed');

    const [updated] = await connection.execute<RequestRow[]>(
      `SELECT ${REQUEST_COLUMNS} FROM agent_pairing_requests WHERE id = ?`,
      [requestId],
    );
    return { outcome: 'decided', request: toReview(updated[0] as RequestRow) };
  });
}
