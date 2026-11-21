import {
  adminMediaPath,
  type AdminMedia,
  type AdminMediaListResponse,
  type Tag,
  type VmIdentity,
} from '@emucat/contracts';
import { useMemo, useRef, useState } from 'react';
import { clearMainMedia, deleteMedia, selectMainMedia } from '../api';
import { formatBytes } from './Agents';
import { VmImage } from './Catalog';
import { ConfirmDialog } from './Dialogs';
import { MainScreenshot, useImageViewer, type GalleryItem } from './Gallery';
import { FormError } from './States';
import { TagEditorDialog, TagList } from './Tags';

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
  onDelete,
  onTags,
  onPreview,
  registerThumbnail,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  busy: boolean;
  onAct: (work: () => Promise<AdminMediaListResponse>) => void;
  onDelete: (item: AdminMedia, opener: HTMLElement) => void;
  onTags: (item: AdminMedia, opener: HTMLElement) => void;
  onPreview: (id: string, opener: HTMLElement) => void;
  registerThumbnail: (id: string, element: HTMLElement | null) => void;
}) {
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
        <TagList tags={item.tags} label={`Tags of ${item.originalFilename}`} className="mb-2" />
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
            className="btn btn-sm btn-outline-secondary theme-button"
            aria-label={`Tags of ${item.originalFilename}`}
            disabled={busy}
            onClick={(event) => onTags(item, event.currentTarget)}
          >
            Tags…
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-danger"
            disabled={busy}
            onClick={(event) => onDelete(item, event.currentTarget)}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * Every screenshot of a VM, in the saved order, with what an administrator can do to each: choose the main
 * image, edit its tags, or delete it.
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
  const [deleting, setDeleting] = useState<AdminMedia | null>(null);
  const [tagging, setTagging] = useState<AdminMedia | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Where the focus goes back to when a dialog closes: the button that opened it, or the grid.
  const opener = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLDivElement>(null);
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
    setNotice(null);
    setBusy(true);
    try {
      onChange(await work());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const restoreFocus = (fallback = false) => {
    const target = opener.current;
    opener.current = null;
    if (!fallback && target?.isConnected) target.focus();
    else grid.current?.focus();
  };

  // A screenshot's tags changed: the list is the same, with that item's tags replaced.
  const tagsChanged = (id: string, tags: Tag[]) => {
    onChange({ media: media.map((item) => (item.id === id ? { ...item, tags } : item)) });
    setTagging((current) => (current?.id === id ? { ...current, tags } : current));
  };

  return (
    <>
      <FormError error={error} />
      {notice ? (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      ) : null}
      {showMain && mainItem ? <MainScreenshot item={mainItem} onOpen={open} /> : null}
      <div className="media-grid" ref={grid} tabIndex={-1} aria-label="Screenshots">
        {media.map((item) => (
          <MediaCard
            key={item.id}
            vm={vm}
            item={item}
            busy={busy}
            onAct={(work) => void act(work)}
            onDelete={(target, element) => {
              opener.current = element;
              setNotice(null);
              setDeleting(target);
            }}
            onTags={(target, element) => {
              opener.current = element;
              setTagging(target);
            }}
            onPreview={open}
            registerThumbnail={registerThumbnail}
          />
        ))}
      </div>
      {viewer}
      {deleting ? (
        <ConfirmDialog
          title="Delete this screenshot?"
          action="Delete screenshot"
          cancelLabel="Keep"
          danger
          onClose={() => {
            setDeleting(null);
            restoreFocus();
          }}
          onConfirm={async () => {
            const next = await deleteMedia(vm, deleting.id);
            onChange(next);
            setNotice(`${deleting.originalFilename} was deleted.`);
            setDeleting(null);
            restoreFocus(true);
          }}
        >
          <div className="d-flex gap-3 align-items-start">
            <div className="confirm-thumbnail">
              <VmImage src={adminMediaPath(vm, deleting.id, 'thumbnail')} alt="" />
            </div>
            <div>
              <p className="mb-2">
                <strong className="media-filename">{deleting.originalFilename}</strong>
                {deleting.isMain ? ' is the main image. Nothing replaces it as the cover.' : null}
              </p>
              <p className="mb-0">
                It is removed from EmuCat, with its files and tags. The file on the agent’s computer
                is not touched, and it is not imported again while it stays the same.
              </p>
            </div>
          </div>
        </ConfirmDialog>
      ) : null}
      {tagging ? (
        <TagEditorDialog
          title="Screenshot tags"
          subject={tagging.originalFilename}
          target={{ kind: 'media', vm: { emulatorType, vmName }, mediaId: tagging.id }}
          value={tagging.tags}
          onChange={(tags) => tagsChanged(tagging.id, tags)}
          onClose={() => {
            setTagging(null);
            restoreFocus();
          }}
        />
      ) : null}
    </>
  );
}
