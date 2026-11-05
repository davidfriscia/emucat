import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import type { SessionCookiePolicy } from '../auth/guards.js';
import type { PasswordHasher } from '../auth/passwords.js';
import type { RateLimiter } from '../auth/rate-limiter.js';
import type { SessionPolicy } from '../auth/sessions.js';
import type { SetupToken } from '../auth/setup.js';
import type { MediaStorage } from '../storage/media-storage.js';
import { registerAdminCatalogRoutes } from './admin-catalog.js';
import { registerAuthRoutes, type AuthRateLimits } from './auth.js';
import { registerPublicCatalogRoutes } from './public-catalog.js';

/** Everything the routes used by the web application need. */
export interface BrowserDependencies {
  pool: Pool;
  storage: MediaStorage;
  passwords: PasswordHasher;
  setupToken: SetupToken;
  limiter: RateLimiter;
  rateLimits: AuthRateLimits;
  session: SessionPolicy;
  cookie: SessionCookiePolicy;
  publicOrigin?: string | undefined;
}

export async function registerBrowserRoutes(
  api: FastifyInstance,
  dependencies: BrowserDependencies,
): Promise<void> {
  await api.register(cookie);
  api.decorateRequest('authSession', null);
  // Every response from these routes: nothing here should ever be interpreted as another type.
  api.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
  });
  registerAuthRoutes(api, dependencies);
  registerPublicCatalogRoutes(api, dependencies);
  registerAdminCatalogRoutes(api, dependencies);
}
