import {
  adminMediaPath,
  adminVmRoute,
  vmPathParamsSchema,
  type AdminMedia,
  type AdminMediaListResponse,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiRequestError,
  clearMainMedia,
  deleteMedia,
  fetchVmMedia,
  selectMainMedia,
  updateMediaVisibility,
} from '../../api';
import { VmImage } from '../../components/Catalog';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { useAsync } from '../../useAsync';
import { NotFoundPage } from '../NotFoundPage';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function publicEffect(item: AdminMedia): string | null {
  if (item.shownAsPublicMain) return 'Shown as the main image in the public catalog.';
  if (!item.isMain) return null;
  return item.visibility === 'private'
    ? 'Selected as main, but private: the public catalog shows a placeholder until it is published.'
    : 'Selected as main, but this VM is private: nobody outside sees it until the VM is public.';
}

function MediaCard({
  vm,
  item,
  busy,
  onAct,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  busy: boolean;
  onAct: (work: () => Promise<AdminMediaListResponse>) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const effect = publicEffect(item);
  return (
    <article className="card h-100">
      <VmImage src={adminMediaPath(vm, item.id, 'thumbnail')} alt={item.originalFilename} />
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

  return (
    <>
      <title>{`Media of ${vmName} · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to={adminVmRoute(vm)}>{vmName}</Link>
      </nav>
      <h1 className="h3 mb-3">Media</h1>
      <p className="small text-body-secondary">
        The public catalog shows the main image only while this VM is public and the image is
        published. Otherwise it shows a placeholder: another image is never chosen automatically.
        Images are independent of VM versions.
      </p>
      <FormError error={error} />
      {state.data.media.length === 0 ? (
        <EmptyState title="No media yet">
          Screenshots will arrive from a connected EmuCat agent in a later milestone.
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
            />
          ))}
        </div>
      )}
    </>
  );
}

export function VmMediaPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <NotFoundPage />;
  return <VmMedia identity={params.data} />;
}
