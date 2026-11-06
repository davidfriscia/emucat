import type { ErrorResponse } from '@emucat/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** An expected failure, with a stable code for clients. Goes through the common error handler. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: NonNullable<ErrorResponse['error']['details']>,
): ErrorResponse {
  return { error: { code, message, requestId: request.id, ...(details ? { details } : {}) } };
}

/** Every failure, including 404s and unexpected exceptions, uses the same response shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply: FastifyReply) => {
    return reply.status(404).send(errorBody(request, 'not_found', 'Route not found'));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation || error instanceof ZodError || error.cause instanceof ZodError) {
      const zodError =
        error instanceof ZodError ? error : error.cause instanceof ZodError ? error.cause : null;
      const details = zodError?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply
        .status(400)
        .send(errorBody(request, 'validation_failed', 'Request validation failed', details));
    }

    const status = error.statusCode ?? 500;
    if (status >= 500 && !((error as Error) instanceof ApiError)) {
      // The cause goes to the log only. Responses never expose internal details.
      request.log.error({ err: error }, 'Request failed');
      return reply.status(status).send(errorBody(request, 'internal_error', 'Internal error'));
    }
    const code = (error.code ?? 'request_error').toLowerCase().replace(/^fst_err_/, '');
    return reply.status(status).send(errorBody(request, code, error.message));
  });
}
