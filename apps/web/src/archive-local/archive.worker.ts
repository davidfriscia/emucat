/// <reference lib="webworker" />
import { serveArchiveRequests } from './worker-handler';

/** The archive worker's entry point: a module worker, bundled and served from this origin as `.js`. */
declare const self: DedicatedWorkerGlobalScope;
serveArchiveRequests(self as unknown as Parameters<typeof serveArchiveRequests>[0]);
