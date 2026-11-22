import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

/** Every route's full path, from Fastify's printed route tree: each line's segment follows its ancestors'. */
export function routePaths(app: FastifyInstance): string[] {
  const stack: Array<{ depth: number; path: string }> = [];
  const paths: string[] = [];
  for (const line of app.printRoutes().split('\n')) {
    const depth = line.search(/[^\s│├└─]/u);
    if (depth < 0) continue;
    const segment = line.slice(depth).replace(/ \(.*\)$/u, '');
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth)
      stack.pop();
    const path = (stack[stack.length - 1]?.path ?? '') + segment;
    stack.push({ depth, path });
    if (/\(/u.test(line)) paths.push(path);
  }
  return paths;
}

/**
 * Archives travel between agents and repositories (decision 0012). Since decision 0055 the only exceptions are the
 * relay, behind the agent's bearer credential, and the administrators' read-only archive listing.
 */
export function expectArchiveRoutesOnlyWhereAllowed(app: FastifyInstance): void {
  const routes = routePaths(app).filter((path) => /upload|download|archive/i.test(path));
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(route).toMatch(
      /^\/api\/v1\/(agent\/repositories\/:repositoryId\/(uploads|downloads)|admin\/vms\/:emulatorType\/:vmName\/versions\/:versionId\/archive)/u,
    );
  }
}
