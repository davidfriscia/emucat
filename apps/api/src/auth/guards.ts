import { CSRF_HEADER } from '@emucat/contracts';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import {
  csrfTokenMatches,
  resolveSession,
  type ResolvedSession,
  type SessionPolicy,
} from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session guard on routes that require a session. */
    authSession: ResolvedSession | null;
  }
}

export interface SessionCookiePolicy {
  /** Sets the `Secure` attribute. On by default in production; see `COOKIE_SECURE`. */
  secure: boolean;
  /** How long the browser keeps the cookie. The server decides whether it is still valid. */
  maxAgeSeconds: number;
}

/** `__Host-` makes browsers refuse the cookie unless it is Secure, host-only and on path `/`. */
export function sessionCookieName(policy: Pick<SessionCookiePolicy, 'secure'>): string {
  return policy.secure ? '__Host-emucat_session' : 'emucat_session';
}

function cookieOptions(policy: SessionCookiePolicy): CookieSerializeOptions {
  return { path: '/', httpOnly: true, sameSite: 'strict', secure: policy.secure };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  policy: SessionCookiePolicy,
): void {
  reply.setCookie(sessionCookieName(policy), token, {
    ...cookieOptions(policy),
    maxAge: policy.maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, policy: SessionCookiePolicy): void {
  reply.clearCookie(sessionCookieName(policy), cookieOptions(policy));
}

export function readSessionCookie(
  request: FastifyRequest,
  policy: SessionCookiePolicy,
): string | undefined {
  return request.cookies[sessionCookieName(policy)];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Fetch metadata values from a page on this origin, or from the user directly. */
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none']);

function isSameOrigin(origin: string, request: FastifyRequest, publicOrigin?: string): boolean {
  try {
    const parsed = new URL(origin);
    return publicOrigin ? parsed.origin === publicOrigin : parsed.host === request.headers.host;
  } catch {
    // Includes `Origin: null`, sent by sandboxed frames and some redirects.
    return false;
  }
}

/**
 * Refuses a state-changing request that a browser says came from another site. It runs before there
 * is a session, so it also protects sign-in and setup, where a CSRF token cannot exist yet. A client
 * that sends neither header is not a browser and so cannot be a CSRF victim, but on session routes it
 * still needs the token.
 */
export function requireSameOrigin(publicOrigin?: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (SAFE_METHODS.has(request.method)) return;
    const fetchSite = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    const crossSite = fetchSite !== undefined && !TRUSTED_FETCH_SITES.has(fetchSite);
    if (crossSite || (origin !== undefined && !isSameOrigin(origin, request, publicOrigin))) {
      throw new ApiError(403, 'cross_origin_rejected', 'Cross-origin request rejected');
    }
  };
}

export interface SessionGuardOptions {
  pool: Pool;
  session: SessionPolicy;
  cookie: SessionCookiePolicy;
}

/**
 * Requires a live session and, on state-changing methods, its CSRF token. These run as `onRequest`
 * hooks, ahead of body parsing and validation, so an anonymous client learns nothing about a route
 * beyond "sign in first".
 */
export function requireSession({ pool, session, cookie }: SessionGuardOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = readSessionCookie(request, cookie);
    const resolved = token ? await resolveSession(pool, token, session) : null;
    if (!resolved) {
      if (token) clearSessionCookie(reply, cookie);
      throw new ApiError(401, 'unauthenticated', 'Sign in required');
    }
    if (!SAFE_METHODS.has(request.method)) {
      if (!csrfTokenMatches(resolved.token, request.headers[CSRF_HEADER])) {
        throw new ApiError(403, 'csrf_rejected', 'Missing or invalid CSRF token');
      }
    }
    request.authSession = resolved;
  };
}

/** Must run after {@link requireSession}. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (request.authSession?.user.role !== 'admin') {
    throw new ApiError(403, 'forbidden', 'Administrator access required');
  }
}

export async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}

export function sessionOf(request: FastifyRequest): ResolvedSession {
  if (!request.authSession) throw new Error('Route is missing the session guard');
  return request.authSession;
}
