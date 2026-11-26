import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * What the browser tests talk to (decision 0058): the built harness, served the way the web container's nginx serves
 * the application (its MIME table, `nosniff`, `X-Frame-Options: DENY`), and a stand-in for the archive routes of the
 * API, which records every request. A module worker served with another type than JavaScript fails here as it would
 * in production.
 */

/** As nginx's stock `mime.types`, for what a build emits. Anything else is `application/octet-stream`. */
const NGINX_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

export type Route = (request: RecordedRequest) => Promise<Response | unknown> | Response | unknown;

export interface HarnessServer {
  url: string;
  requests: RecordedRequest[];
  routes: Map<string, Route>;
  close(): Promise<void>;
}

async function sendResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

export async function startServer(root: string): Promise<HarnessServer> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, Route>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://harness.test');
    const record = {
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
    };
    requests.push(record);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/perf/')) {
      const key = `${record.method} ${record.path.replace(/^\/api\/v1/u, '')}`;
      const route = routes.get(key);
      if (!route) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ error: { code: 'not_found', message: key, requestId: 'harness' } }),
        );
        return;
      }
      const result = await route(record);
      if (result instanceof Response) await sendResponse(res, result);
      else await sendResponse(res, Response.json(result));
      return;
    }
    const relative = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(
      /^(\.\.[/\\])+/u,
      '',
    );
    const file = join(root, relative);
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.setHeader('content-type', NGINX_TYPES[extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
