import {
  notesEtagSchema,
  saveVmNotesRequestSchema,
  vmPathParamsSchema,
  type SaveVmNotesRequest,
  type VmIdentity,
  type VmNotes,
} from '@emucat/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { noStore, requireAdmin, requireSameOrigin, requireSession } from '../auth/guards.js';
import { ApiError } from '../errors.js';
import { NotesError } from '../notes/storage.js';
import type { BrowserDependencies } from './browser.js';

const NOTES_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Per-VM Markdown notes (decision 0053). Administrators only: notes are private, and no public route returns them.
 * The file's path is derived from the VM's identity as the catalog stores it; a request can only name a VM.
 *
 * Saving is optimistic: `GET` returns an `ETag`, and `PUT` and `DELETE` must send it back as `If-Match`. Notes that
 * changed since are refused with `412 notes_conflict` rather than overwritten.
 */
export function registerAdminNotesRoutes(
  parent: FastifyInstance,
  dependencies: BrowserDependencies,
): void {
  const { pool, session, cookie, publicOrigin, notes } = dependencies;

  /** The VM as the catalog spells it. Lookup ignores case, as everywhere. */
  const canonical = async (vm: VmIdentity): Promise<VmIdentity> => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT emulator_type, vm_name FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
      [vm.emulatorType, vm.vmName],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
    return {
      emulatorType: row.emulator_type as VmIdentity['emulatorType'],
      vmName: row.vm_name as string,
    };
  };

  const storage = () => {
    if (!notes) {
      throw new ApiError(503, 'notes_unavailable', 'Notes are not configured on this server.');
    }
    return notes;
  };

  const ifMatch = (request: FastifyRequest): string => {
    const header = request.headers['if-match'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) {
      throw new ApiError(428, 'precondition_required', 'Send the notes’ ETag as If-Match.');
    }
    const parsed = notesEtagSchema.safeParse(value.trim());
    if (!parsed.success)
      throw new ApiError(400, 'validation_failed', 'If-Match is not a notes ETag');
    return parsed.data;
  };

  const answer = (reply: FastifyReply, result: VmNotes): VmNotes => {
    reply.header('etag', result.etag);
    return result;
  };

  const failure = (error: unknown): never => {
    if (error instanceof NotesError) {
      switch (error.kind) {
        case 'conflict':
          throw new ApiError(
            412,
            'notes_conflict',
            'The notes were changed since they were loaded. Reload them, and apply your changes again.',
          );
        case 'too_large':
          throw new ApiError(413, 'notes_too_large', error.message);
        case 'unsafe':
          // Never says which path: only that the storage refused to follow it.
          throw new ApiError(
            500,
            'notes_storage_unsafe',
            'The notes storage refused an unsafe path.',
          );
        case 'unavailable':
          throw new ApiError(503, 'notes_unavailable', error.message);
      }
    }
    throw error;
  };

  void parent.register(
    async (api) => {
      api.addHook('onRequest', requireSameOrigin(publicOrigin));
      api.addHook('onRequest', noStore);
      api.addHook('onRequest', requireSession({ pool, session, cookie }));
      api.addHook('onRequest', requireAdmin);

      api.get(
        '/vms/:emulatorType/:vmName/notes',
        { schema: { params: vmPathParamsSchema } },
        async (request, reply): Promise<VmNotes> => {
          const vm = await canonical(request.params as VmIdentity);
          try {
            return answer(reply, await storage().read(vm));
          } catch (error) {
            return failure(error);
          }
        },
      );

      api.put(
        '/vms/:emulatorType/:vmName/notes',
        {
          bodyLimit: NOTES_MAX_BODY_BYTES,
          schema: { params: vmPathParamsSchema, body: saveVmNotesRequestSchema },
        },
        async (request, reply): Promise<VmNotes> => {
          const vm = await canonical(request.params as VmIdentity);
          const expected = ifMatch(request);
          const { markdown } = request.body as SaveVmNotesRequest;
          try {
            const saved = await storage().write(vm, markdown, expected);
            request.log.info({ vm, sizeBytes: saved.sizeBytes }, 'VM notes saved');
            return answer(reply, saved);
          } catch (error) {
            return failure(error);
          }
        },
      );

      api.delete(
        '/vms/:emulatorType/:vmName/notes',
        { schema: { params: vmPathParamsSchema } },
        async (request, reply): Promise<VmNotes> => {
          const vm = await canonical(request.params as VmIdentity);
          const expected = ifMatch(request);
          try {
            const cleared = await storage().clear(vm, expected);
            request.log.info({ vm }, 'VM notes cleared');
            return answer(reply, cleared);
          } catch (error) {
            return failure(error);
          }
        },
      );
    },
    { prefix: '/admin' },
  );
}
