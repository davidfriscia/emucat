import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CurrentUser, SetupRequest } from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';
import { createSession, type ResolvedSession, type SessionPolicy } from './sessions.js';

/** Proves that whoever claims a fresh installation can also see its configuration or its logs. */
export interface SetupToken {
  matches(candidate: string): boolean;
  /** Tells the operator the generated token, once. Does nothing for a configured token. */
  announce(log: (token: string) => void): void;
}

export function createSetupToken(configured?: string): SetupToken {
  const value = configured ?? randomBytes(32).toString('base64url');
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  let announced = configured !== undefined;
  return {
    matches: (candidate) => timingSafeEqual(digest(candidate), digest(value)),
    announce(log) {
      if (announced) return;
      announced = true;
      log(value);
    },
  };
}

export async function isSetupRequired(pool: Pool): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT NOT EXISTS (SELECT 1 FROM system_bootstrap)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS required`,
  );
  return Number(rows[0]?.required) === 1;
}

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

/**
 * Creates the first administrator and a session for them, atomically. The first statement inserts
 * the fixed-key row in `system_bootstrap`: concurrent attempts wait on it and then fail with a
 * duplicate key, and an attempt that rolls back leaves the way open for the next. Returns `null` if
 * setup has already happened.
 */
export async function bootstrapAdministrator(
  pool: Pool,
  request: Pick<SetupRequest, 'username' | 'displayName'>,
  passwordHash: string,
  policy: SessionPolicy,
): Promise<ResolvedSession | null> {
  try {
    return await withTransaction(pool, async (connection) => {
      await connection.execute('INSERT INTO system_bootstrap (id, admin_user_id) VALUES (1, NULL)');
      const [admins] = await connection.query<RowDataPacket[]>(
        "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1",
      );
      if (admins.length > 0) throw Object.assign(new Error('Exists'), { code: DUPLICATE_ENTRY });

      const user: CurrentUser = {
        id: randomUUID(),
        username: request.username,
        displayName: request.displayName,
        role: 'admin',
      };
      await connection.execute(
        `INSERT INTO users (id, username, display_name, password_hash, role)
         VALUES (?, ?, ?, ?, 'admin')`,
        [user.id, user.username, user.displayName, passwordHash],
      );
      await connection.execute('UPDATE system_bootstrap SET admin_user_id = ? WHERE id = 1', [
        user.id,
      ]);
      return createSession(connection, user, policy);
    });
  } catch (error) {
    if ((error as { code?: string }).code === DUPLICATE_ENTRY) return null;
    throw error;
  }
}
