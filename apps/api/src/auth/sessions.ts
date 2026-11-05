import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedSession, CurrentUser, SessionInfo, UserRole } from '@emucat/contracts';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashToken } from './agent-auth.js';

export interface SessionPolicy {
  /** A session unused for this long expires. Each use extends it, up to the absolute limit. */
  idleTtlSeconds: number;
  /** A session expires this long after sign-in, however active it is. */
  absoluteTtlSeconds: number;
}

export interface ResolvedSession {
  id: string;
  /** The raw token from the cookie. It stays in memory and is never stored or logged. */
  token: string;
  expiresAt: Date;
  user: CurrentUser;
}

type Executor = Pool | PoolConnection;

const LAST_SEEN_RESOLUTION_SECONDS = 60;
const EXPIRED_SESSION_RETENTION_DAYS = 30;
const CSRF_CONTEXT = 'emucat-csrf-v1';

/** 256 bits from the operating system's generator. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The CSRF token is derived from the session token, so it needs no storage, dies with the session,
 * and cannot be computed by a page that cannot read the HttpOnly cookie.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_CONTEXT).digest('base64url');
}

export function csrfTokenMatches(sessionToken: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function describeSession(session: ResolvedSession): AuthenticatedSession {
  return {
    user: session.user,
    csrfToken: csrfTokenFor(session.token),
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export async function createSession(
  executor: Executor,
  user: CurrentUser,
  policy: SessionPolicy,
): Promise<ResolvedSession> {
  const id = randomUUID();
  const token = generateSessionToken();
  const lifetime = Math.min(policy.idleTtlSeconds, policy.absoluteTtlSeconds);
  await executor.execute(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND)`,
    [id, user.id, hashToken(token), lifetime],
  );
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT expires_at FROM user_sessions WHERE id = ?',
    [id],
  );
  return { id, token, expiresAt: rows[0]?.expires_at as Date, user };
}

interface SessionRow extends RowDataPacket {
  session_id: string;
  expires_at: Date;
  user_id: string;
  username: string;
  display_name: string;
  role: UserRole;
}

/** Checked on every request. Expired, revoked and disabled-user sessions all resolve to `null`. */
export async function resolveSession(
  pool: Pool,
  token: string,
  policy: SessionPolicy,
): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(token);
  const [rows] = await pool.execute<SessionRow[]>(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.display_name, u.role
     FROM user_sessions AS s
     JOIN users AS u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > UTC_TIMESTAMP(3)
       AND u.disabled_at IS NULL
     LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;

  // Writes at most once a minute per session, so that reads do not all become writes. Never moves
  // expiry forward past the absolute limit, and LEAST() also means it can never exceed it.
  await pool.execute(
    `UPDATE user_sessions
     SET last_seen_at = UTC_TIMESTAMP(3),
         expires_at = LEAST(
           created_at + INTERVAL ? SECOND,
           UTC_TIMESTAMP(3) + INTERVAL ? SECOND
         )
     WHERE id = ?
       AND revoked_at IS NULL
       AND last_seen_at < UTC_TIMESTAMP(3) - INTERVAL ? SECOND`,
    [
      policy.absoluteTtlSeconds,
      policy.idleTtlSeconds,
      row.session_id,
      LAST_SEEN_RESOLUTION_SECONDS,
    ],
  );

  return {
    id: row.session_id,
    token,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    },
  };
}

export async function revokeSessionByToken(pool: Pool, token: string): Promise<void> {
  await pool.execute(
    'UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL',
    [hashToken(token)],
  );
}

/** Revokes one of the user's own sessions. Returns whether it existed and was active. */
export async function revokeUserSession(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
    [sessionId, userId],
  );
  return result.affectedRows > 0;
}

export async function revokeOtherSessions(
  executor: Executor,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const [result] = await executor.execute<ResultSetHeader>(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
     WHERE user_id = ? AND id <> ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
    [userId, keepSessionId],
  );
  return result.affectedRows;
}

interface SessionListRow extends RowDataPacket {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export async function listActiveSessions(
  pool: Pool,
  userId: string,
  currentSessionId: string,
): Promise<SessionInfo[]> {
  const [rows] = await pool.execute<SessionListRow[]>(
    `SELECT id, created_at, last_seen_at, expires_at
     FROM user_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
     ORDER BY last_seen_at DESC, id`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    current: row.id === currentSessionId,
  }));
}

/** Old rows have no use, and removing them on sign-in keeps the table from growing forever. */
export async function purgeDeadSessions(pool: Pool): Promise<void> {
  await pool.execute(
    `DELETE FROM user_sessions
     WHERE expires_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY
        OR revoked_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY`,
    [EXPIRED_SESSION_RETENTION_DAYS, EXPIRED_SESSION_RETENTION_DAYS],
  );
}
