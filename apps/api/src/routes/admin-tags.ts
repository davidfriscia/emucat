import {
  createTagRequestSchema,
  tagListQuerySchema,
  type CreateTagRequest,
  type CreateTagResponse,
  type TagListQuery,
  type TagListResponse,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { createTag, listTags } from '../catalog/tags.js';
import type { BrowserDependencies } from './browser.js';

/**
 * The central tag catalog (decision 0050). Administrators only: a tag's existence says something about private
 * VMs, versions and screenshots, so there is no public listing. Assigning tags is done on each entity's own route.
 * There is deliberately no generic update or delete: a tag is a name, and an unused one costs nothing.
 */
export function registerAdminTagRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/tags',
        { schema: { querystring: tagListQuerySchema } },
        async (request): Promise<TagListResponse> => {
          const { q, limit } = request.query as TagListQuery;
          return { tags: await listTags(pool, q, limit) };
        },
      );

      api.post(
        '/tags',
        { schema: { body: createTagRequestSchema } },
        async (request, reply): Promise<CreateTagResponse> => {
          const { name } = request.body as CreateTagRequest;
          const result = await createTag(pool, name, sessionOf(request).user.id);
          if (result.created) request.log.info({ tagId: result.tag.id }, 'Tag created');
          reply.status(result.created ? 201 : 200);
          return result;
        },
      );
    },
    { prefix: '/admin' },
  );
}
