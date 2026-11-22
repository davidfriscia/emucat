import { useCaptureGalleryRefresh } from '../../../components/CaptureScreenshot';
import type { AdminMediaListResponse, AdminMediaSyncResponse, VmIdentity } from '@emucat/contracts';
import { useCallback, useRef, useState } from 'react';
import { fetchVmMedia, fetchVmMediaSync } from '../../../api';
import { ReorderScreenshotsDialog } from '../../../components/ReorderScreenshots';
import { EmptyState, ErrorState, LoadingState } from '../../../components/States';
import { VmMediaGrid } from '../../../components/VmMediaGrid';
import { useAsync } from '../../../useAsync';
import { usePolledData } from '../../../usePolledData';
import { PublicCoverNotice } from './VmGeneralPage';
import { useVmManage } from './VmManageLayout';

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

/**
 * Screenshots: the VM's gallery, its cover, order, tags and deletion, and how the agents' uploads are going.
 * Screenshots are media of their own (decision 0051): nothing here reads or changes the VM's archives, versions,
 * verification or transfers.
 */
export function VmScreenshotsPage() {
  const { identity, vm, title, refreshVm } = useVmManage();
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchVmMedia({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);
  const refreshCapturedMedia = useCallback(() => {
    void fetchVmMedia({ emulatorType, vmName }).then(setData, () => undefined);
  }, [emulatorType, vmName, setData]);
  useCaptureGalleryRefresh({ emulatorType, vmName }, refreshCapturedMedia);
  const [reordering, setReordering] = useState(false);
  const [reordered, setReordered] = useState(false);
  const reorderButton = useRef<HTMLButtonElement>(null);

  // A change to a screenshot can change the VM's cover, and the server is what says how.
  const mediaChanged = (next: AdminMediaListResponse) => {
    setData(next);
    refreshVm();
  };

  const media = state.status === 'success' ? state.data.media : [];
  return (
    <section aria-labelledby="vm-screenshots-heading">
      <title>{`${title} · Screenshots · Manage · EmuCat`}</title>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h2 id="vm-screenshots-heading" className="h5 mb-0 flex-grow-1">
          Screenshots
        </h2>
        {state.status === 'success' ? (
          <button
            ref={reorderButton}
            type="button"
            className="btn btn-outline-primary"
            disabled={media.length < 2}
            title={media.length < 2 ? 'There is nothing to reorder yet' : undefined}
            onClick={() => {
              setReordered(false);
              setReordering(true);
            }}
          >
            Reorder Screenshots
          </button>
        ) : null}
      </div>
      {reordered ? (
        <div className="alert alert-success" role="status">
          The new order is saved. Every gallery shows it.
        </div>
      ) : null}
      <p className="small text-body-secondary">
        Screenshots arrive from the agent that holds this VM. They have no visibility of their own:
        all of them are public while this VM is public, and none of them while it is private. The
        main image is only the public catalog’s cover. With none selected, the catalog shows a
        placeholder: another image is never chosen automatically. Images are independent of VM
        versions.
      </p>
      <div className="mb-3">
        <PublicCoverNotice vm={vm} />
      </div>
      <SyncSummary vm={identity} />
      {state.status === 'loading' ? <LoadingState label="Loading screenshots" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          title="The screenshots could not be loaded"
          error={state.error}
          onRetry={reload}
        />
      ) : null}
      {state.status === 'success' && media.length === 0 ? (
        <EmptyState title="No screenshots yet">
          Screenshots appear here shortly after the agent finds them in this VM’s directory. They
          are not in the VM’s archive, and nothing here reads or changes the VM itself.
        </EmptyState>
      ) : null}
      {state.status === 'success' && media.length > 0 ? (
        <VmMediaGrid vm={identity} media={media} onChange={mediaChanged} showMain />
      ) : null}
      {reordering && state.status === 'success' ? (
        <ReorderScreenshotsDialog
          vm={identity}
          media={media}
          onSaved={(next) => {
            mediaChanged(next);
            setReordered(true);
          }}
          onClose={() => {
            setReordering(false);
            reorderButton.current?.focus();
          }}
        />
      ) : null}
    </section>
  );
}
