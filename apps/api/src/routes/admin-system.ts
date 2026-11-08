import {
  APP_VERSION,
  startUpdateRequestSchema,
  updateOperationPathParamsSchema,
  type ApplicationUpdatesResponse,
  type BuildInfo,
  type DeploymentStatus,
  type StartUpdateRequest,
  type SystemVersionResponse,
  type UpdateLogResponse,
  type UpdateOperation,
} from '@emucat/contracts';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { DeploymentServiceError, type DeploymentClient } from '../deployment/client.js';
import { ApiError } from '../errors.js';
import type { BrowserDependencies } from './browser.js';

export interface DeploymentDependencies {
  /** `null` when no deployment service is configured, as in development. */
  client: DeploymentClient | null;
  environment: string;
  build: BuildInfo;
}

export const NO_DEPLOYMENT: DeploymentDependencies = {
  client: null,
  environment: 'development',
  build: { version: APP_VERSION, commit: null, builtAt: null },
};

function translate(error: unknown): never {
  if (error instanceof DeploymentServiceError) {
    if (error.kind === 'unavailable') {
      throw new ApiError(503, 'deployment_service_unavailable', error.message);
    }
    throw new ApiError(error.statusCode, error.code, error.message);
  }
  throw error;
}

async function statusOrNull(
  client: DeploymentClient,
  log: FastifyBaseLogger,
): Promise<DeploymentStatus | null> {
  try {
    return await client.status();
  } catch (error) {
    log.warn({ err: error }, 'Deployment service status unavailable');
    return null;
  }
}

/**
 * Version reporting and administrator-triggered application updates. Administrators only. The API holds
 * no deployment privilege of its own: every action is a fixed request to the local deployment service,
 * which runs the update, owns its state and survives the API being replaced underneath it.
 */
export function registerAdminSystemRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;
  const deployment = dependencies.deployment ?? NO_DEPLOYMENT;
  const { client } = deployment;

  const requireClient = (): DeploymentClient => {
    if (!client) {
      throw new ApiError(
        503,
        'deployment_service_not_configured',
        'Application updates are not configured on this server',
      );
    }
    return client;
  };

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get('/version', async (request): Promise<SystemVersionResponse> => {
        const status = client ? await statusOrNull(client, request.log) : null;
        return {
          environment: deployment.environment,
          applicationVersion: deployment.build.version,
          buildCommit: deployment.build.commit,
          buildTimestamp: deployment.build.builtAt,
          deployedCommit: status?.current?.commit ?? null,
          deploymentTimestamp: status?.current?.deployedAt ?? null,
          deploymentStatus: !status
            ? 'unknown'
            : status.activeOperation
              ? 'updating'
              : status.current
                ? 'deployed'
                : 'not_deployed',
          service: !client ? 'not_configured' : status ? 'connected' : 'unavailable',
        };
      });

      api.get('/updates', async (request): Promise<ApplicationUpdatesResponse> => {
        const status = client ? await statusOrNull(client, request.log) : null;
        return {
          service: !client ? 'not_configured' : status ? 'connected' : 'unavailable',
          build: deployment.build,
          deployment: status,
        };
      });

      api.post('/updates/check', async (request): Promise<ApplicationUpdatesResponse> => {
        const status = await requireClient().check().catch(translate);
        request.log.info(
          { userId: sessionOf(request).user.id, latest: status.latest?.commit ?? null },
          'Application update check',
        );
        return { service: 'connected', build: deployment.build, deployment: status };
      });

      api.post(
        '/updates',
        { schema: { body: startUpdateRequestSchema } },
        async (request, reply): Promise<UpdateOperation> => {
          const { expectedCommit } = request.body as StartUpdateRequest;
          const { user } = sessionOf(request);
          const operation = await requireClient()
            .start({ expectedCommit, requestedBy: user.username })
            .catch(translate);
          request.log.info(
            { userId: user.id, operationId: operation.id, targetCommit: operation.targetCommit },
            'Application update started',
          );
          reply.status(202);
          return operation;
        },
      );

      api.get(
        '/updates/:operationId',
        { schema: { params: updateOperationPathParamsSchema } },
        async (request): Promise<UpdateOperation> => {
          const { operationId } = request.params as z.infer<typeof updateOperationPathParamsSchema>;
          const operation = await requireClient().operation(operationId).catch(translate);
          if (!operation) throw new ApiError(404, 'operation_not_found', 'Update not found');
          return operation;
        },
      );

      api.get(
        '/updates/:operationId/log',
        { schema: { params: updateOperationPathParamsSchema } },
        async (request): Promise<UpdateLogResponse> => {
          const { operationId } = request.params as z.infer<typeof updateOperationPathParamsSchema>;
          const log = await requireClient().log(operationId).catch(translate);
          if (!log) throw new ApiError(404, 'operation_not_found', 'Update not found');
          return log;
        },
      );
    },
    { prefix: '/admin/system' },
  );
}
