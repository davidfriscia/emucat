import {
  adminMediaPath,
  type AdminMedia,
  type AdminMediaListResponse,
  type VmIdentity,
} from '@emucat/contracts';
import { useMemo, useState } from 'react';
import { clearMainMedia, deleteMedia, selectMainMedia } from '../api';
import { formatBytes } from './Agents';
import { VmImage } from './Catalog';
import { MainScreenshot, useImageViewer, type GalleryItem } from './Gallery';
import { FormError } from './States';

/** What being the main image means right now. Who may see a screenshot is the VM's visibility alone. */
function publicEffect(item: AdminMedia): string | null {
  if (item.shownAsPublicMain) return 'Shown as the main image in the public catalog.';
  if (!item.isMain) return null;
  return 'Selected as main, but this VM is private: nobody outside sees it until the VM is public.';
}

function formatUploaded(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

function MediaCard({
  vm,
  item,
  busy,
  onAct,
  onPreview,
  registerThumbnail,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  busy: boolean;
  onAct: (work: () => Promise<AdminMediaListResponse>) => void;
  onPreview: (id: string, opener: HTMLElement) => void;
  registerThumbnail: (id: string, element: HTMLElement | null) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const effect = publicEffect(item);
  return (
    <article className="card h-100">
      <button
        ref={(element) => registerThumbnail(item.id, element)}
        type="button"
        className="media-thumbnail-button"
        aria-label={`View ${item.originalFilename} at full resolution`}
        onClick={(event) => onPreview(item.id, event.currentTarget)}
      >
        <VmImage src={adminMediaPath(vm, item.id, 'thumbnail')} alt="" />
      </button>
      <div className="card-body d-flex flex-column">
        <h2 className="h6 card-title media-filename">{item.originalFilename}</h2>
        {item.isMain ? (
          <div className="d-flex flex-wrap gap-1 mb-2">
            <span className="badge text-bg-primary">Main image</span>
          </div>
        ) : null}
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

/**
 * Every screenshot of a VM, with what an administrator can do to each: choose the main image, or delete it.
 * There is no per-screenshot publication: screenshots are public exactly while their VM is. It is used by
 * the VM's page and its media page, and both get the same viewer as the public gallery. Originals appear
 * only as an explicit download: what is displayed is always a derivative.
 */
export function VmMediaGrid({
  vm,
  media,
  onChange,
  showMain = false,
}: {
  vm: VmIdentity;
  media: readonly AdminMedia[];
  onChange: (next: AdminMediaListResponse) => void;
  /** Shows the main screenshot prominently, above the rest. */
  showMain?: boolean;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { emulatorType, vmName } = vm;
  const items = useMemo<GalleryItem[]>(() => {
    const identity = { emulatorType, vmName };
    return media.map((item) => ({
      id: item.id,
      label: item.originalFilename,
      thumbnailSrc: adminMediaPath(identity, item.id, 'thumbnail'),
      fullSrc: adminMediaPath(identity, item.id, 'full'),
      widthPx: item.widthPx,
      heightPx: item.heightPx,
      viewerActions: (
        <a
          className="btn btn-sm btn-outline-light"
          href={adminMediaPath(identity, item.id, 'original')}
          download
        >
          Download original
        </a>
      ),
    }));
  }, [media, emulatorType, vmName]);
  const { open, registerThumbnail, viewer } = useImageViewer(items);
  const mainId = media.find((item) => item.isMain)?.id;
  const mainItem = items.find((item) => item.id === mainId) ?? null;

  const act = async (work: () => Promise<AdminMediaListResponse>) => {
    setError(null);
    setBusy(true);
    try {
      onChange(await work());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormError error={error} />
      {showMain && mainItem ? <MainScreenshot item={mainItem} onOpen={open} /> : null}
      <div className="media-grid">
        {media.map((item) => (
          <MediaCard
            key={item.id}
            vm={vm}
            item={item}
            busy={busy}
            onAct={(work) => void act(work)}
            onPreview={open}
            registerThumbnail={registerThumbnail}
          />
        ))}
      </div>
      {viewer}
    </>
  );
}
