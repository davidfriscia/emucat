import {
  adminVmRoute,
  EMULATOR_LABELS,
  publicMediaPath,
  publicVmRoute,
  vmPathParamsSchema,
  vmTitle,
  type PublicMedia,
  type PublicVmDetail,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ApiRequestError, fetchPublicVm } from '../api';
import { useAuth } from '../auth';
import { EmulatorBadge } from '../components/Catalog';
import { VmLaunchDialog } from '../components/Execution';
import {
  CardSizeControl,
  MainScreenshot,
  ThumbnailGrid,
  useGalleryCardSize,
  useImageViewer,
  type GalleryItem,
} from '../components/Gallery';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../useAsync';

function MissingVm() {
  return (
    <>
      <title>Not available · EmuCat</title>
      <EmptyState
        title="This virtual machine is not available"
        action={
          <Link to="/" className="btn btn-outline-primary">
            Back to the catalog
          </Link>
        }
      >
        It does not exist, or it is not public.
      </EmptyState>
    </>
  );
}

/**
 * The page's main action. Launching is for administrators, so everyone else is told what it takes rather
 * than shown a button that fails.
 */
function LaunchAction({ vm, title }: { vm: VmIdentity; title: string }) {
  const { state: auth } = useAuth();
  const [open, setOpen] = useState(false);

  if (auth.status === 'loading') {
    return (
      <button type="button" className="btn btn-primary btn-lg vm-launch-button" disabled>
        Launch VM
      </button>
    );
  }
  if (auth.status !== 'authenticated') {
    return (
      <Link
        to={`/login?next=${encodeURIComponent(publicVmRoute(vm))}`}
        className="btn btn-primary btn-lg vm-launch-button"
      >
        Sign in to launch
      </Link>
    );
  }
  if (auth.session.user.role !== 'admin') {
    return (
      <div className="vm-launch-button">
        <button
          type="button"
          className="btn btn-primary btn-lg w-100"
          disabled
          aria-describedby="launch-help"
        >
          Launch VM
        </button>
        <div id="launch-help" className="form-text mt-1">
          Only administrators can launch VMs.
        </div>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-lg vm-launch-button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Launch VM
      </button>
      {open ? <VmLaunchDialog vm={vm} title={title} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** What the catalog knows about the VM: nothing more is invented for the page. */
function GeneralInformation({
  vm,
  main,
  onOpen,
}: {
  vm: PublicVmDetail;
  main: GalleryItem | null;
  onOpen: (id: string, opener: HTMLElement) => void;
}) {
  const count = vm.gallery.length;
  return (
    <section className="card vm-info mb-4" aria-labelledby="vm-info-heading">
      <div className="card-body">
        <h2 id="vm-info-heading" className="h5 card-title">
          General information
        </h2>
        <div className="vm-info-layout">
          <div className="vm-info-cover">
            <MainScreenshot item={main} onOpen={onOpen} />
          </div>
          <div className="vm-info-text">
            <dl className="vm-facts">
              <div>
                <dt>Emulator</dt>
                <dd>{EMULATOR_LABELS[vm.emulatorType]}</dd>
              </div>
              <div>
                <dt>VM name</dt>
                <dd className="vm-identity">{vm.vmName}</dd>
              </div>
              <div>
                <dt>Screenshots</dt>
                <dd>{count === 0 ? 'None yet' : count}</dd>
              </div>
            </dl>
            <h3 className="h6 mt-3">Description</h3>
            {vm.description ? (
              <p className="vm-description mb-0">{vm.description}</p>
            ) : (
              <p className="small text-body-secondary mb-0">No description yet.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ScreenshotGallery({
  items,
  onOpen,
  registerThumbnail,
  openId,
}: {
  items: readonly GalleryItem[];
  onOpen: (id: string, opener: HTMLElement) => void;
  registerThumbnail: (id: string, element: HTMLElement | null) => void;
  openId: string | null;
}) {
  const [size, setSize] = useGalleryCardSize();
  if (items.length === 0) {
    return <p className="small text-body-secondary">There are no screenshots yet.</p>;
  }
  return (
    <section aria-labelledby="screenshots-heading">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h2 id="screenshots-heading" className="h5 mb-0">
          Screenshots
        </h2>
        <span className="small text-body-secondary flex-grow-1">
          {items.length === 1 ? '1 image' : `${items.length} images`}
        </span>
        <CardSizeControl value={size} onChange={setSize} />
      </div>
      <ThumbnailGrid
        items={items}
        onOpen={onOpen}
        registerThumbnail={registerThumbnail}
        openId={openId}
        size={size}
      />
    </section>
  );
}

function galleryItems(
  title: string,
  gallery: readonly PublicMedia[],
  mainImage: PublicMedia | null,
): GalleryItem[] {
  return gallery.map((image, index) => ({
    id: image.id,
    label:
      image.id === mainImage?.id ? `Screenshot of ${title}` : `Screenshot ${index + 1} of ${title}`,
    thumbnailSrc: publicMediaPath(image.id, 'thumbnail'),
    fullSrc: publicMediaPath(image.id, 'full'),
    widthPx: image.widthPx,
    heightPx: image.heightPx,
    isMain: image.id === mainImage?.id,
  }));
}

function VmDetailContent({ vm, isAdmin }: { vm: PublicVmDetail; isAdmin: boolean }) {
  const title = vmTitle(vm);
  const items = useMemo(
    () => galleryItems(title, vm.gallery, vm.mainImage),
    [title, vm.gallery, vm.mainImage],
  );
  // One viewer for the cover and the thumbnails, so that it moves through the whole gallery from either.
  const { open, registerThumbnail, viewer, openId } = useImageViewer(items);
  const main = items.find((item) => item.isMain) ?? null;
  return (
    <article>
      <title>{`${title} · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to="/">
          <span aria-hidden="true">← </span>Back to the catalog
        </Link>
      </nav>
      <header className="vm-detail-header mb-4">
        <div className="vm-detail-heading">
          <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
            <h1 className="h2 mb-0">{title}</h1>
            <EmulatorBadge emulatorType={vm.emulatorType} />
          </div>
          {title !== vm.vmName ? (
            <p className="small text-body-secondary vm-identity mb-0">{vm.vmName}</p>
          ) : null}
        </div>
        <div className="vm-detail-actions">
          <LaunchAction vm={vm} title={title} />
          {isAdmin ? (
            <Link to={adminVmRoute(vm)} className="btn btn-outline-primary">
              Manage this VM
            </Link>
          ) : null}
        </div>
      </header>
      <GeneralInformation vm={vm} main={main} onOpen={open} />
      <ScreenshotGallery
        items={items}
        onOpen={open}
        registerThumbnail={registerThumbnail}
        openId={openId}
      />
      {viewer}
    </article>
  );
}

function VmDetail({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchPublicVm({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload } = useAsync(load);
  const { state: auth } = useAuth();
  const isAdmin = auth.status === 'authenticated' && auth.session.user.role === 'admin';

  if (state.status === 'loading') return <LoadingState label="Loading the virtual machine" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      // A private VM is still this administrator's to see, on the page that checks that they may.
      if (auth.status === 'loading') return <LoadingState label="Loading the virtual machine" />;
      if (isAdmin) return <Navigate to={adminVmRoute(identity)} replace />;
      return <MissingVm />;
    }
    return <ErrorState error={state.error} onRetry={reload} />;
  }
  return <VmDetailContent vm={state.data} isAdmin={isAdmin} />;
}

export function VmDetailPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <MissingVm />;
  // Remounted for another VM, so that nothing from the previous one lingers.
  return (
    <VmDetail key={`${params.data.emulatorType}/${params.data.vmName}`} identity={params.data} />
  );
}
