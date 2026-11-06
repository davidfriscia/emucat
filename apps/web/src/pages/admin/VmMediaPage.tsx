import {
  adminMediaPath,
  adminVmRoute,
  vmPathParamsSchema,
  type AdminMedia,
  type AdminMediaListResponse,
  type AdminMediaSyncResponse,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiRequestError,
  clearMainMedia,
  deleteMedia,
  fetchVmMedia,
  fetchVmMediaSync,
  selectMainMedia,
  updateMediaVisibility,
} from '../../api';
import { VmImage } from '../../components/Catalog';
import { formatBytes } from '../../components/Agents';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { useAsync } from '../../useAsync';
import { usePolledData } from '../../usePolledData';
import { NotFoundPage } from '../NotFoundPage';

function publicEffect(item: AdminMedia): string | null {
  if (item.shownAsPublicMain) return 'Shown as the main image in the public catalog.';
  if (!item.isMain) return null;
  return item.visibility === 'private'
    ? 'Selected as main, but private: the public catalog shows a placeholder until it is published.'
    : 'Selected as main, but this VM is private: nobody outside sees it until the VM is public.';
}

const SYNC_POLL_MS = 5_000;

function formatUploaded(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

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

/** The whole image, over the page. Escape or the button closes it, and focus goes back where it was. */
function MediaPreview({
  vm,
  item,
  onClose,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  // Once only: anything else re-rendering this must not take the focus away.
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="media-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Full-resolution view of ${item.originalFilename}`}
    >
      <div className="d-flex flex-wrap align-items-center gap-2">
        <span className="small media-filename flex-grow-1">
          {item.originalFilename}, {item.widthPx} × {item.heightPx}
        </span>
        <a
          className="btn btn-sm btn-outline-light"
          href={adminMediaPath(vm, item.id, 'original')}
          download
        >
          Download original
        </a>
        <button ref={close} type="button" className="btn btn-sm btn-light" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="media-preview-frame">
        <img src={adminMediaPath(vm, item.id, 'full')} alt={item.originalFilename} />
      </div>
    </div>
  );
}

function MediaCard({
  vm,
  item,
  busy,
  onAct,
  onPreview,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  busy: boolean;
  onAct: (work: () => Promise<AdminMediaListResponse>) => void;
  onPreview: (item: AdminMedia, opener: HTMLElement) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const effect = publicEffect(item);
  return (
    <article className="card h-100">
      <button
        type="button"
        className="media-thumbnail-button"
        aria-label={`View ${item.originalFilename} at full resolution`}
        onClick={(event) => onPreview(item, event.currentTarget)}
      >
        <VmImage src={adminMediaPath(vm, item.id, 'thumbnail')} alt="" />
      </button>
      <div className="card-body d-flex flex-column">
        <h2 className="h6 card-title media-filename">{item.originalFilename}</h2>
        <div className="d-flex flex-wrap gap-1 mb-2">
          {item.visibility === 'published' ? (
            <span className="badge text-bg-success">Published</span>
          ) : (
            <span className="badge text-bg-dark border">Private</span>
          )}
          {item.isMain ? <span className="badge text-bg-primary">Main image</span> : null}
        </div>
        <p className="small text-body-secondary mb-2">
          {item.widthPx} × {item.heightPx}, {formatBytes(item.originalSizeBytes)}
          <br />
          Uploaded {formatUploaded(item.createdAt)}
        </p>
        {effect ? <p className="small">{effect}</p> : null}
        <div className="d-flex flex-wrap gap-2 mt-auto">
          {item.isMain ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy}
              onClick={() => onAct(() => clearMainMedia(vm))}
            >
              Clear main image
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy}
              onClick={() => onAct(() => selectMainMedia(vm, item.id))}
            >
              Set as main image
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            disabled={busy}
            onClick={() =>
              onAct(() =>
                updateMediaVisibility(
                  vm,
                  item.id,
                  item.visibility === 'published' ? 'private' : 'published',
                ),
              )
            }
          >
            {item.visibility === 'published' ? 'Make private' : 'Publish'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => onAct(() => deleteMedia(vm, item.id))}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </article>
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
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closePreview = () => {
    setPreviewId(null);
    opener.current?.focus();
  };

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

  const act = async (work: () => Promise<AdminMediaListResponse>) => {
    setError(null);
    setBusy(true);
    try {
      setData(await work());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const previewItem = state.data.media.find((item) => item.id === previewId) ?? null;

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
      <FormError error={error} />
      {state.data.media.length === 0 ? (
        <EmptyState title="No media yet">
          Screenshots appear here shortly after the agent finds them in this VM’s directory. They
          are not in the VM’s archive, and nothing here reads or changes the VM itself.
        </EmptyState>
      ) : (
        <div className="media-grid">
          {state.data.media.map((item) => (
            <MediaCard
              key={item.id}
              vm={vm}
              item={item}
              busy={busy}
              onAct={(work) => void act(work)}
              onPreview={(chosen, element) => {
                opener.current = element;
                setPreviewId(chosen.id);
              }}
            />
          ))}
        </div>
      )}
      {previewItem ? <MediaPreview vm={vm} item={previewItem} onClose={closePreview} /> : null}
    </>
  );
}

export function VmMediaPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <NotFoundPage />;
  return <VmMedia identity={params.data} />;
}
