import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AgentPrincipal {
  agentId: string;
}

/** Resolves an agent bearer token to an agent, or `null` if it is not currently valid. */
export type AgentAuthenticator = (token: string) => Promise<AgentPrincipal | null>;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Looks up a token by digest. Revocation removes the digest, and is also checked here, so a revoked
 * agent cannot authenticate by either route. An unknown token and a revoked one look the same.
 */
export function databaseAgentAuthenticator(pool: Pool): AgentAuthenticator {
  return async (token) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM agents WHERE credential_hash = ? AND revoked_at IS NULL LIMIT 1',
      [hashToken(token)],
    );
    const id = rows[0]?.id as string | undefined;
    return id ? { agentId: id } : null;
  };
}

/** Extracts a token from an `Authorization: Bearer <token>` header. */
export function parseBearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(header ?? '');
  return match?.[1] ?? null;
}
