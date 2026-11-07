import {
  dismissSessionRequestSchema,
  launchRequestSchema,
  stopSessionRequestSchema,
  verificationPathParamsSchema,
  verifyRequestSchema,
  vmPathParamsSchema,
  vmSessionListQuerySchema,
  vmSessionPathParamsSchema,
  type DismissSessionRequest,
  type ExecutionOptionsResponse,
  type LaunchRequest,
  type StopSessionRequest,
  type VerifyRequest,
  type VmIdentity,
  type VmSession,
  type VmSessionListResponse,
  type VmVerification,
} from '@emucat/contracts';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  noStore,
  requireAdmin,
  requireSameOrigin,
  requireSession,
  sessionOf,
} from '../auth/guards.js';
import { vmExists } from '../catalog/repository.js';
import { ApiError } from '../errors.js';
import type { ExecutionCoordinator } from '../execution/coordinator.js';
import type { BrowserDependencies } from './browser.js';

/**
 * Running VMs and verifying local copies. Administrators only. A request names an agent, a VM and a
 * mode, and never a command, a path or a process: the agent builds and checks all of that itself.
 */
export function registerAdminExecutionRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
  execution: ExecutionCoordinator,
): void {
  const { pool, session, cookie, publicOrigin } = dependencies;

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/vms/:emulatorType/:vmName/execution-options',
        { schema: { params: vmPathParamsSchema } },
        async (request): Promise<ExecutionOptionsResponse> => {
          const vm = request.params as VmIdentity;
          if (!(await vmExists(pool, vm))) {
            throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
          }
          return execution.executionOptions(vm);
        },
      );

      api.get(
        '/sessions',
        { schema: { querystring: vmSessionListQuerySchema } },
        async (request): Promise<VmSessionListResponse> => ({
          sessions: await execution.listSessions(
            request.query as z.infer<typeof vmSessionListQuerySchema>,
          ),
        }),
      );

      api.post(
        '/sessions',
        { schema: { body: launchRequestSchema } },
        async (request, reply): Promise<VmSession> => {
          const body = request.body as LaunchRequest;
          const launched = await execution.launch(body, sessionOf(request).user.id);
          request.log.info(
            { sessionId: launched.id, vmName: launched.vmName, agentId: body.agentId },
            'Launch requested',
          );
          reply.status(202);
          return launched;
        },
      );

      api.get(
        '/sessions/:sessionId',
        { schema: { params: vmSessionPathParamsSchema } },
        async (request): Promise<VmSession> => {
          const { sessionId } = request.params as z.infer<typeof vmSessionPathParamsSchema>;
          const found = await execution.getSession(sessionId);
          if (!found) throw new ApiError(404, 'session_not_found', 'Session not found');
          return found;
        },
      );

      api.post(
        '/sessions/:sessionId/stop',
        { schema: { params: vmSessionPathParamsSchema, body: stopSessionRequestSchema } },
        async (request, reply): Promise<VmSession> => {
          const { sessionId } = request.params as z.infer<typeof vmSessionPathParamsSchema>;
          const body = request.body as StopSessionRequest;
          const stopped = await execution.stop(sessionId, body);
          request.log.info({ sessionId, force: body.force }, 'Stop requested');
          reply.status(202);
          return stopped;
        },
      );

      api.post(
        '/sessions/:sessionId/dismiss',
        { schema: { params: vmSessionPathParamsSchema, body: dismissSessionRequestSchema } },
        async (request): Promise<VmSession> => {
          const { sessionId } = request.params as z.infer<typeof vmSessionPathParamsSchema>;
          const body = request.body as DismissSessionRequest;
          const dismissed = await execution.dismiss(sessionId, body.confirmVmName);
          request.log.warn({ sessionId }, 'Session dismissed by an administrator');
          return dismissed;
        },
      );

      api.post(
        '/verifications',
        { schema: { body: verifyRequestSchema } },
        async (request, reply): Promise<VmVerification> => {
          const body = request.body as VerifyRequest;
          const started = await execution.verify(body, sessionOf(request).user.id);
          request.log.info(
            { verificationId: started.id, vmName: started.vmName, agentId: body.agentId },
            'Verification requested',
          );
          reply.status(202);
          return started;
        },
      );

      api.get(
        '/verifications/:verificationId',
        { schema: { params: verificationPathParamsSchema } },
        async (request): Promise<VmVerification> => {
          const { verificationId } = request.params as z.infer<typeof verificationPathParamsSchema>;
          const found = await execution.getVerification(verificationId);
          if (!found) throw new ApiError(404, 'verification_not_found', 'Verification not found');
          return found;
        },
      );
    },
    { prefix: '/admin' },
  );
}
