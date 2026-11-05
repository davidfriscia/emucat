import {
  changePasswordRequestSchema,
  isValidUsername,
  loginRequestSchema,
  setupRequestSchema,
  type AuthenticatedSession,
  type RevokedSessionsResponse,
  type SessionListResponse,
  type SessionStateResponse,
  type SetupStatusResponse,
  type UserRole,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import {
  clearSessionCookie,
  noStore,
  readSessionCookie,
  requireSameOrigin,
  requireSession,
  sessionOf,
  setSessionCookie,
  type SessionCookiePolicy,
} from '../auth/guards.js';
import type { RateLimiter, RateLimitKey, RateLimitRule } from '../auth/rate-limiter.js';
import {
  createSession,
  describeSession,
  listActiveSessions,
  purgeDeadSessions,
  resolveSession,
  revokeOtherSessions,
  revokeSessionByToken,
  revokeUserSession,
  type ResolvedSession,
} from '../auth/sessions.js';
import { bootstrapAdministrator, isSetupRequired } from '../auth/setup.js';
import { withTransaction } from '../db/pool.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

export interface AuthRateLimits {
  loginPerAddress: RateLimitRule;
  /** Counted across all addresses. Set high enough that a stranger cannot easily lock out the admin. */
  loginPerUsername: RateLimitRule;
  setupPerAddress: RateLimitRule;
  passwordChangePerUser: RateLimitRule;
}

const FIFTEEN_MINUTES = 15 * 60;

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  loginPerAddress: { maxAttempts: 20, windowSeconds: FIFTEEN_MINUTES },
  loginPerUsername: { maxAttempts: 50, windowSeconds: FIFTEEN_MINUTES },
  setupPerAddress: { maxAttempts: 10, windowSeconds: FIFTEEN_MINUTES },
  passwordChangePerUser: { maxAttempts: 10, windowSeconds: FIFTEEN_MINUTES },
};

function enforceRateLimit(
  limiter: RateLimiter,
  reply: FastifyReply,
  keys: readonly RateLimitKey[],
): void {
  const decision = limiter.attempt(keys);
  if (!decision.allowed) {
    reply.header('retry-after', String(decision.retryAfterSeconds));
    throw new ApiError(429, 'rate_limited', 'Too many attempts. Try again later.');
  }
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  disabled_at: Date | null;
}

function startSession(
  reply: FastifyReply,
  session: ResolvedSession,
  cookie: SessionCookiePolicy,
): AuthenticatedSession {
  setSessionCookie(reply, session.token, cookie);
  return describeSession(session);
}

const INVALID_CREDENTIALS = () =>
  new ApiError(401, 'invalid_credentials', 'Invalid username or password');

/** Setup and sign-in: the routes reachable before there is a session. */
function registerAnonymousRoutes(api: FastifyInstance, dependencies: BrowserDependencies): void {
  const { pool, passwords, limiter, rateLimits, session, cookie, publicOrigin } = dependencies;

  api.addHook('onRequest', requireSameOrigin(publicOrigin));
  api.addHook('onRequest', noStore);

  api.get('/setup/status', async (request): Promise<SetupStatusResponse> => {
    const setupRequired = await isSetupRequired(pool);
    if (setupRequired) announceSetupToken(request, dependencies);
    return { setupRequired };
  });

  api.post('/setup', { schema: { body: setupRequestSchema } }, async (request, reply) => {
    const body = request.body as z.infer<typeof setupRequestSchema>;
    const keys = [{ key: `setup:ip:${request.ip}`, rule: rateLimits.setupPerAddress }];
    enforceRateLimit(limiter, reply, keys);

    const setupCompleted = () =>
      new ApiError(409, 'setup_completed', 'Setup has already been completed');
    if (!(await isSetupRequired(pool))) throw setupCompleted();
    if (!dependencies.setupToken.matches(body.setupToken)) {
      throw new ApiError(403, 'invalid_setup_token', 'Invalid setup token');
    }

    // Hashing is slow, so it happens before the transaction opens and holds any lock.
    const passwordHash = await passwords.hash(body.password);
    const created = await bootstrapAdministrator(pool, body, passwordHash, session);
    if (!created) throw setupCompleted();

    limiter.release(keys);
    request.log.info({ userId: created.user.id }, 'First administrator created');
    return reply.status(201).send(startSession(reply, created, cookie));
  });

  api.post('/auth/login', { schema: { body: loginRequestSchema } }, async (request, reply) => {
    const { username, password } = request.body as z.infer<typeof loginRequestSchema>;
    const wellFormed = isValidUsername(username);
    const keys: RateLimitKey[] = [
      { key: `login:ip:${request.ip}`, rule: rateLimits.loginPerAddress },
      // A malformed name matches no account, so tracking it would only let a client fill the table.
      ...(wellFormed
        ? [{ key: `login:user:${username.toLowerCase()}`, rule: rateLimits.loginPerUsername }]
        : []),
    ];
    enforceRateLimit(limiter, reply, keys);

    let user: UserRow | undefined;
    if (wellFormed) {
      const [rows] = await pool.execute<UserRow[]>(
        `SELECT id, username, display_name, password_hash, role, disabled_at
         FROM users WHERE username = ? LIMIT 1`,
        [username],
      );
      user = rows[0];
    }
    // Every path does one password verification and gives one answer. An unknown user, a disabled
    // user and a wrong password are indistinguishable by response and by work done.
    if (!user) {
      await passwords.verifyAgainstDummy(password);
      throw INVALID_CREDENTIALS();
    }
    const valid = await passwords.verify(user.password_hash, password);
    if (!valid || user.disabled_at !== null) throw INVALID_CREDENTIALS();

    limiter.release(keys);

    // A new token on every sign-in, so a token planted before it is worthless afterwards.
    const previous = readSessionCookie(request, cookie);
    if (previous) await revokeSessionByToken(pool, previous);
    await purgeDeadSessions(pool);
    const created = await createSession(
      pool,
      { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
      session,
    );
    return startSession(reply, created, cookie);
  });

  // For the web app's first request on each page load. Answers 200 either way, so that an anonymous
  // visit to the public catalog does not log a failed request.
  api.get('/auth/session', async (request, reply): Promise<SessionStateResponse> => {
    const token = readSessionCookie(request, cookie);
    const resolved = token ? await resolveSession(pool, token, session) : null;
    if (token && !resolved) clearSessionCookie(reply, cookie);
    return { session: resolved ? describeSession(resolved) : null };
  });
}

/** Routes for any signed-in user, acting on their own account. */
function registerAccountRoutes(api: FastifyInstance, dependencies: BrowserDependencies): void {
  const { pool, passwords, limiter, rateLimits, session, cookie, publicOrigin } = dependencies;

  api.addHook('onRequest', noStore);
  api.addHook('onRequest', requireSameOrigin(publicOrigin));
  api.addHook('onRequest', requireSession({ pool, session, cookie }));

  api.get('/auth/me', (request): AuthenticatedSession => describeSession(sessionOf(request)));

  api.post('/auth/logout', async (request, reply) => {
    await revokeSessionByToken(pool, sessionOf(request).token);
    clearSessionCookie(reply, cookie);
    return reply.status(204).send();
  });

  api.get('/account/sessions', async (request): Promise<SessionListResponse> => {
    const current = sessionOf(request);
    return { sessions: await listActiveSessions(pool, current.user.id, current.id) };
  });

  api.post('/account/sessions/revoke-others', async (request): Promise<RevokedSessionsResponse> => {
    const current = sessionOf(request);
    return { revoked: await revokeOtherSessions(pool, current.user.id, current.id) };
  });

  const sessionParams = z.strictObject({ sessionId: z.uuid() });
  api.delete(
    '/account/sessions/:sessionId',
    { schema: { params: sessionParams } },
    async (request: FastifyRequest, reply) => {
      const current = sessionOf(request);
      const { sessionId } = request.params as z.infer<typeof sessionParams>;
      // Scoped to the current user: someone else's session looks the same as a missing one.
      if (!(await revokeUserSession(pool, current.user.id, sessionId))) {
        throw new ApiError(404, 'session_not_found', 'Session not found');
      }
      if (sessionId === current.id) clearSessionCookie(reply, cookie);
      return reply.status(204).send();
    },
  );

  api.post(
    '/account/password',
    { schema: { body: changePasswordRequestSchema } },
    async (request, reply): Promise<RevokedSessionsResponse> => {
      const current = sessionOf(request);
      const body = request.body as z.infer<typeof changePasswordRequestSchema>;
      const keys = [
        { key: `password:user:${current.user.id}`, rule: rateLimits.passwordChangePerUser },
      ];
      enforceRateLimit(limiter, reply, keys);

      const [rows] = await pool.execute<UserRow[]>('SELECT password_hash FROM users WHERE id = ?', [
        current.user.id,
      ]);
      const stored = rows[0]?.password_hash;
      if (!stored || !(await passwords.verify(stored, body.currentPassword))) {
        // Not 401: the session is fine, and the web app must not treat this as being signed out.
        throw new ApiError(403, 'invalid_current_password', 'The current password is not correct');
      }
      limiter.release(keys);

      const passwordHash = await passwords.hash(body.newPassword);
      const revoked = await withTransaction(pool, async (connection) => {
        await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
          passwordHash,
          current.user.id,
        ]);
        return revokeOtherSessions(connection, current.user.id, current.id);
      });
      return { revoked };
    },
  );
}

export function announceSetupToken(
  request: { log: { warn(message: string): void } },
  dependencies: Pick<BrowserDependencies, 'setupToken'>,
): void {
  dependencies.setupToken.announce((token) => {
    request.log.warn(
      `First-run setup is pending. Open /setup in the web app and enter this one-time token: ${token}`,
    );
  });
}

export function registerAuthRoutes(api: FastifyInstance, dependencies: BrowserDependencies): void {
  void api.register(async (scope) => registerAnonymousRoutes(scope, dependencies));
  void api.register(async (scope) => registerAccountRoutes(scope, dependencies));
}
