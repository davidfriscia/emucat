import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

type Level = 'debug' | 'info' | 'warn';

/**
 * How loudly a finished request is logged. The web application rereads the pages it shows, so a successful read is
 * `debug`; everything that changes something, every failure (authentication included), and every WebSocket upgrade,
 * which is how an agent connects, stays at `info` or above.
 */
export function requestLogLevel(method: string, statusCode: number): Level {
  if (statusCode >= 400) return 'warn';
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  return read && statusCode >= 200 && statusCode < 400 ? 'debug' : 'info';
}

/**
 * Fastify's request log, at the level above. A request is announced at `debug` only, so its completion names it,
 * method and URL included. Errors keep Fastify's own handling: a request that errored is still logged as an error.
 */
export class RequestLogController extends LogController {
  override incomingRequest(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.debug({ req: request }, 'incoming request');
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    if (error) {
      super.requestCompleted(error, request, reply, metadata);
      return;
    }
    if (this.isLogDisabled(request)) return;
    reply.log[requestLogLevel(request.method, reply.statusCode)](
      { req: request, res: reply, responseTime: reply.elapsedTime },
      'request completed',
    );
  }
}
