import { LocalArchiveError } from './errors';
import { ArchiveHost, newOperation } from './host';
import { DEFAULT_LOCAL_LIMITS } from './limits';
import type { Operation } from './operation';
import type { WorkerRequest, WorkerResponse, WorkerResult } from './protocol';

/**
 * What the archive worker does (decision 0058), one per open Archive Explorer, terminated when it closes. It holds every nested
 * archive's bytes and index, and does all parsing and decompression, so that none of it runs on the page's thread.
 * It makes no network request and touches no storage: it only answers the page.
 */

export interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

interface State {
  host: ArchiveHost;
  running: Map<number, Operation>;
}

const spansBuffer = (bytes: Uint8Array) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;

async function handle(
  state: State,
  request: WorkerRequest,
  operation: Operation,
): Promise<[WorkerResult, Transferable[]]> {
  const { host, running } = state;
  switch (request.type) {
    case 'configure':
      host.releaseAll();
      state.host = new ArchiveHost(request.limits);
      return [{ type: 'configure' }, []];
    case 'open': {
      const result = await host.open({
        id: request.id,
        name: request.name,
        bytes: request.bytes ? new Uint8Array(request.bytes) : undefined,
        parent: request.parent,
        pinned: request.pinned,
        operation,
      });
      return [{ type: 'open', result }, []];
    }
    case 'details':
      return [
        { type: 'details', result: await host.details(request.id, request.entryIndex, operation) },
        [],
      ];
    case 'read': {
      const result = await host.read(
        request.id,
        request.entryIndex,
        request.kind,
        request.offset,
        operation,
      );
      // Archive bytes stay here: what is sent is a copy of the part asked for.
      const bytes = result.bytes.slice();
      return [{ type: 'read', result: { ...result, bytes } }, [bytes.buffer]];
    }
    case 'image': {
      const result = await host.image(request.id, request.entryIndex, operation);
      const bytes = result.bytes.slice();
      const transfer: Transferable[] = [bytes.buffer];
      if (result.rgba) transfer.push(result.rgba.data.buffer);
      return [{ type: 'image', result: { ...result, bytes } }, transfer];
    }
    case 'download': {
      const result = await host.download(request.id, request.entryIndex, operation);
      // A view into an archive held here is copied, never detached; a decompressed copy is handed over as it is.
      const data = result.view || !spansBuffer(result.data) ? result.data.slice() : result.data;
      return [{ type: 'download', result: { data, integrity: result.integrity } }, [data.buffer]];
    }
    case 'release': {
      const released = request.ids.flatMap((id) => host.release(id));
      return [{ type: 'release', released }, []];
    }
    case 'stats':
      return [{ type: 'stats', result: host.stats() }, []];
    case 'cancel':
      running.get(request.target)?.cancel();
      return [{ type: 'cancel' }, []];
  }
}

export function serveArchiveRequests(scope: WorkerScope): void {
  const state: State = { host: new ArchiveHost({ ...DEFAULT_LOCAL_LIMITS }), running: new Map() };
  const { running } = state;
  scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    const operation = newOperation(state.host.limits);
    if (request.type !== 'cancel') running.set(request.op, operation);
    void handle(state, request, operation)
      .then(([value, transfer]) => {
        if (operation.isCancelled) {
          // Finished after all, but no longer wanted: an archive opened for it is not kept.
          if (request.type === 'open') state.host.release(request.id);
          throw new LocalArchiveError('cancelled');
        }
        const response: WorkerResponse = { op: request.op, ok: true, value };
        scope.postMessage(response, transfer);
      })
      .catch((error: unknown) => {
        const known =
          error instanceof LocalArchiveError ? error : new LocalArchiveError('worker_failed');
        const response: WorkerResponse = {
          op: request.op,
          ok: false,
          code: known.code,
          message: known.message,
        };
        scope.postMessage(response);
      })
      .finally(() => running.delete(request.op));
  };
}
