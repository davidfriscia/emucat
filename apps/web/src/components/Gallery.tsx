import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BrandMark } from './Brand';
import { VmImage } from './Catalog';

/** Open dialogs, innermost last. Only the innermost one answers the keyboard. */
const openDialogs: object[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Everything a modal dialog owes the keyboard: focus goes in when it opens, Tab stays inside, Escape
 * closes it, the page behind does not scroll, and the caller gets to put focus back on close.
 */
export function useModalDialog(
  dialog: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // Once only: anything re-rendering the dialog must not take the focus away.
  useEffect(() => {
    (initialFocus.current ?? dialog.current)?.focus();
  }, [dialog, initialFocus]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    // A dialog opened from inside another one, such as a confirmation, owns the keyboard until it closes.
    const token = {};
    openDialogs.push(token);
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const outside = !dialog.current.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(token), 1);
    };
  }, [dialog, onClose]);
}

/** One screenshot in a gallery, whoever is allowed to see it. */
export interface GalleryItem {
  id: string;
  /** What the image is, for someone who cannot see it. */
  label: string;
  thumbnailSrc: string;
  /** A derivative, never an original. */
  fullSrc: string;
  widthPx: number;
  heightPx: number;
  /** The VM's main cover, marked as such in the thumbnails. */
  isMain?: boolean;
  /** Extra controls in the viewer's bar, for administrators. */
  viewerActions?: ReactNode;
}

function ViewerImage({ item }: { item: GalleryItem }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  if (status === 'failed') {
    return (
      <div className="image-viewer-message" role="alert">
        <BrandMark size={64} />
        <p className="mt-2 mb-0">This image could not be loaded.</p>
      </div>
    );
  }
  return (
    <>
      {status === 'loading' ? (
        <div className="image-viewer-message" role="status">
          <span className="spinner-border" aria-hidden="true" />
          <span className="visually-hidden">Loading the image</span>
        </div>
      ) : null}
      <img
        src={item.fullSrc}
        alt={item.label}
        hidden={status === 'loading'}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('failed')}
      />
    </>
  );
}

/**
 * The whole image, over the page. Arrow keys and the buttons move through the gallery, Escape or the button
 * closes it, and Tab stays inside. The caller decides where focus goes afterwards, since it knows which
 * thumbnail stands for the image the viewer ended on.
 */
export function ImageViewer({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: readonly GalleryItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, closeButton, onClose);

  const count = items.length;
  const move = useCallback(
    (step: number) => {
      if (count > 1) onIndexChange((index + step + count) % count);
    },
    [count, index, onIndexChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [move]);

  const item = items[index];
  if (!item) return null;
  return (
    <div
      ref={dialog}
      className="media-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Full-resolution view of ${item.label}`}
    >
      <div className="d-flex flex-wrap align-items-center gap-2">
        <span className="small media-filename flex-grow-1">
          {item.label}, {item.widthPx} × {item.heightPx}
          {count > 1 ? (
            <span className="ms-2 text-nowrap">
              ({index + 1} of {count})
            </span>
          ) : null}
        </span>
        {item.viewerActions}
        {count > 1 ? (
          <>
            <button type="button" className="btn btn-sm btn-outline-light" onClick={() => move(-1)}>
              Previous
            </button>
            <button type="button" className="btn btn-sm btn-outline-light" onClick={() => move(1)}>
              Next
            </button>
          </>
        ) : null}
        <button ref={closeButton} type="button" className="btn btn-sm btn-light" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="media-preview-frame">
        {/* A new image starts over, with its own loading state. */}
        <ViewerImage key={item.id} item={item} />
      </div>
    </div>
  );
}

/** How many thumbnails appear at first, and how many more each time. They load lazily either way. */
export const GALLERY_PAGE_SIZE = 24;

/**
 * Keeps track of which image the viewer shows, and puts focus back on the thumbnail of the image it
 * ended on. Shared by the public gallery and the administrators' one, so that they behave alike.
 */
export function useImageViewer(items: readonly GalleryItem[]) {
  const [openId, setOpenId] = useState<string | null>(null);
  const thumbnails = useRef(new Map<string, HTMLElement>());
  const fallback = useRef<HTMLElement | null>(null);
  const index = items.findIndex((item) => item.id === openId);

  const open = useCallback((id: string, opener: HTMLElement) => {
    fallback.current = opener;
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    const target = openId ? thumbnails.current.get(openId) : undefined;
    setOpenId(null);
    (target ?? fallback.current)?.focus();
  }, [openId]);
  const registerThumbnail = useCallback((id: string, element: HTMLElement | null) => {
    if (element) thumbnails.current.set(id, element);
    else thumbnails.current.delete(id);
  }, []);

  const viewer =
    index >= 0 ? (
      <ImageViewer
        items={items}
        index={index}
        onIndexChange={(next) => setOpenId(items[next]?.id ?? null)}
        onClose={close}
      />
    ) : null;
  return { open, registerThumbnail, viewer, openId };
}

/** The main image, prominently, when there is one that this viewer may see. */
export function MainScreenshot({
  item,
  onOpen,
}: {
  item: GalleryItem | null;
  onOpen: (id: string, opener: HTMLElement) => void;
}) {
  return (
    <div className="vm-detail-media rounded-3 overflow-hidden border mb-3">
      {item ? (
        <button
          type="button"
          className="media-thumbnail-button"
          aria-label="View the main screenshot at full resolution"
          onClick={(event) => onOpen(item.id, event.currentTarget)}
        >
          <VmImage src={item.fullSrc} alt={item.label} markSize={96} />
        </button>
      ) : (
        <VmImage src={null} alt="" markSize={96} />
      )}
    </div>
  );
}

/** How big each screenshot card is in a thumbnail grid. A viewer's choice, never stored on the server. */
export const GALLERY_CARD_SIZES = ['small', 'medium', 'large'] as const;
export type GalleryCardSize = (typeof GALLERY_CARD_SIZES)[number];

const CARD_SIZE_TEXT: Record<GalleryCardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

const CARD_SIZE_KEY = 'emucat.gallery.cardSize';

function isCardSize(value: unknown): value is GalleryCardSize {
  return GALLERY_CARD_SIZES.includes(value as GalleryCardSize);
}

/** The viewer's card size, remembered in this browser when it can be. Storage may be unavailable. */
export function useGalleryCardSize(): [GalleryCardSize, (size: GalleryCardSize) => void] {
  const [size, setSize] = useState<GalleryCardSize>(() => {
    try {
      const stored = localStorage.getItem(CARD_SIZE_KEY);
      return isCardSize(stored) ? stored : 'medium';
    } catch {
      return 'medium';
    }
  });
  const choose = useCallback((next: GalleryCardSize) => {
    setSize(next);
    try {
      localStorage.setItem(CARD_SIZE_KEY, next);
    } catch {
      // Remembering it is a convenience; the choice still applies to this page.
    }
  }, []);
  return [size, choose];
}

/** Small, medium or large cards, as one group of toggle buttons that the keyboard reaches as radios. */
export function CardSizeControl({
  value,
  onChange,
}: {
  value: GalleryCardSize;
  onChange: (size: GalleryCardSize) => void;
}) {
  return (
    <div className="btn-group btn-group-sm" role="radiogroup" aria-label="Screenshot size">
      {GALLERY_CARD_SIZES.map((size) => (
        <label
          key={size}
          className={`btn btn-outline-primary${value === size ? ' active' : ''}`}
          htmlFor={`card-size-${size}`}
        >
          <input
            id={`card-size-${size}`}
            type="radio"
            className="visually-hidden"
            name="gallery-card-size"
            value={size}
            checked={value === size}
            onChange={() => onChange(size)}
          />
          {CARD_SIZE_TEXT[size]}
        </label>
      ))}
    </div>
  );
}

/** Thumbnails of what this viewer may see. Only thumbnails load here, and only as they scroll into view. */
export function ThumbnailGrid({
  items,
  onOpen,
  registerThumbnail,
  openId,
  size = 'medium',
}: {
  items: readonly GalleryItem[];
  onOpen: (id: string, opener: HTMLElement) => void;
  registerThumbnail: (id: string, element: HTMLElement | null) => void;
  openId: string | null;
  size?: GalleryCardSize;
}) {
  const [shown, setShown] = useState(GALLERY_PAGE_SIZE);
  const openIndex = items.findIndex((item) => item.id === openId);
  // The viewer can move past what is shown, and closing it has to find that image's thumbnail.
  const visible = items.slice(0, Math.max(shown, openIndex + 1));
  const remaining = items.length - visible.length;
  return (
    <>
      <div className="gallery-grid" data-size={size}>
        {visible.map((item) => (
          <button
            key={item.id}
            ref={(element) => registerThumbnail(item.id, element)}
            type="button"
            className={`media-thumbnail-button gallery-card rounded-2 overflow-hidden border${item.isMain ? ' gallery-card-main' : ''}`}
            aria-label={`View ${item.label} at full resolution${item.isMain ? ', the main cover' : ''}`}
            onClick={(event) => onOpen(item.id, event.currentTarget)}
          >
            <VmImage src={item.thumbnailSrc} alt="" />
            {item.isMain ? (
              <span className="badge text-bg-primary gallery-card-badge" aria-hidden="true">
                Main cover
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {remaining > 0 ? (
        <div className="text-center mt-3">
          <button
            type="button"
            className="btn btn-outline-primary"
            onClick={() => setShown(visible.length + GALLERY_PAGE_SIZE)}
          >
            Show more ({remaining} left)
          </button>
        </div>
      ) : null}
    </>
  );
}
