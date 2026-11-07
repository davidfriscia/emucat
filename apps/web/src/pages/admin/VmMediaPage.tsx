import {
  adminVmRoute,
  vmPathParamsSchema,
  type AdminMediaSyncResponse,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { ApiRequestError, fetchVmMedia, fetchVmMediaSync } from '../../api';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { VmMediaGrid } from '../../components/VmMediaGrid';
import { useAsync } from '../../useAsync';
import { usePolledData } from '../../usePolledData';
import { NotFoundPage } from '../NotFoundPage';

const SYNC_POLL_MS = 5_000;

/** What each agent holding this VM last said. It is a report, and nothing here depends on it. */
function SyncSummary({ vm }: { vm: VmIdentity }) {
  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) => fetchVmMediaSync({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { data, error } = usePolledData<AdminMediaSyncResponse>(load, SYNC_POLL_MS);
  if (!data) {
    return error ? (
      <p className="small text-body-secondary">The synchronization status is not available.</p>
    ) : null;
  }
  if (data.agents.length === 0) {
    return (
      <p className="small text-body-secondary">
        No agent holds this VM, so no new screenshots will arrive.
      </p>
    );
  }
  return (
    <section aria-label="Screenshot synchronization" className="mb-3">
      {data.agents.map(({ agentId, agentName, online, status }) => (
        <div key={agentId} className="border rounded-2 p-2 small mb-2">
          <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
            <strong className="media-filename">{agentName}</strong>
            <span className={`badge ${online ? 'text-bg-success' : 'text-bg-dark border'}`}>
              {online ? 'Online' : 'Offline'}
            </span>
          </div>
          {status ? (
            <>
              <dl className="media-sync-counts">
                <div>
                  <dt>Pending</dt>
                  <dd>{status.pending}</dd>
                </div>
                <div>
                  <dt>Uploading</dt>
                  <dd>{status.uploading}</dd>
                </div>
                <div>
                  <dt>Synchronized</dt>
                  <dd>{status.synchronized}</dd>
                </div>
                <div>
                  <dt>Failed</dt>
                  <dd>{status.failed}</dd>
                </div>
              </dl>
              {status.lastError ? (
                <p className="text-danger mb-0 mt-1 media-filename">
                  {status.lastError.sourcePath ? `${status.lastError.sourcePath}: ` : ''}
                  {status.lastError.message}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-body-secondary mb-0">
              {online ? 'Nothing reported yet.' : 'It has not reported since the server started.'}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function VmMedia({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const vm = { emulatorType, vmName };
  const load = useCallback(
    (signal: AbortSignal) => fetchVmMedia({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);

  if (state.status === 'loading') return <LoadingState label="Loading media" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <EmptyState
          title="This virtual machine is not registered"
          action={
            <Link to="/admin/catalog" className="btn btn-outline-primary">
              Back to the catalog
            </Link>
          }
        >
          It may have a different name, or it may not have been registered yet.
        </EmptyState>
      );
    }
    return <ErrorState error={state.error} onRetry={reload} />;
  }

  return (
    <>
      <title>{`Media of ${vmName} · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to={adminVmRoute(vm)}>{vmName}</Link>
      </nav>
      <h1 className="h3 mb-3">Media</h1>
      <p className="small text-body-secondary">
        Screenshots arrive from the agent that holds this VM, and stay private until you publish
        them here. Publishing an image is separate from publishing the VM. The public catalog shows
        the main image only while this VM is public and the image is published. Otherwise it shows a
        placeholder: another image is never chosen automatically. Images are independent of VM
        versions.
      </p>
      <SyncSummary vm={vm} />
      {state.data.media.length === 0 ? (
        <EmptyState title="No media yet">
          Screenshots appear here shortly after the agent finds them in this VM’s directory. They
          are not in the VM’s archive, and nothing here reads or changes the VM itself.
        </EmptyState>
      ) : (
        <VmMediaGrid vm={vm} media={state.data.media} onChange={setData} />
      )}
    </>
  );
}

export function VmMediaPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <NotFoundPage />;
  return <VmMedia identity={params.data} />;
}
