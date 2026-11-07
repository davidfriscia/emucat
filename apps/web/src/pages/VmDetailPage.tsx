import {
  adminVmRoute,
  publicMediaPath,
  vmPathParamsSchema,
  vmTitle,
  type PublicMedia,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ApiRequestError, fetchPublicVm } from '../api';
import { useAuth } from '../auth';
import { EmulatorBadge } from '../components/Catalog';
import {
  MainScreenshot,
  ThumbnailGrid,
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

function PublicGallery({
  title,
  gallery,
  mainImage,
}: {
  title: string;
  gallery: readonly PublicMedia[];
  mainImage: PublicMedia | null;
}) {
  const items = useMemo<GalleryItem[]>(
    () =>
      gallery.map((image, index) => ({
        id: image.id,
        label:
          image.id === mainImage?.id
            ? `Screenshot of ${title}`
            : `Screenshot ${index + 1} of ${title}`,
        thumbnailSrc: publicMediaPath(image.id, 'thumbnail'),
        fullSrc: publicMediaPath(image.id, 'full'),
        widthPx: image.widthPx,
        heightPx: image.heightPx,
      })),
    [gallery, mainImage, title],
  );
  const { open, registerThumbnail, viewer, openId } = useImageViewer(items);
  const main = items.find((item) => item.id === mainImage?.id) ?? null;
  return (
    <>
      <MainScreenshot item={main} onOpen={open} />
      {items.length > 0 ? (
        <section className="mt-4" aria-labelledby="screenshots-heading">
          <h2 id="screenshots-heading" className="h5">
            Screenshots
          </h2>
          <ThumbnailGrid
            items={items}
            onOpen={open}
            registerThumbnail={registerThumbnail}
            openId={openId}
          />
        </section>
      ) : (
        <p className="small text-body-secondary">No screenshots have been published yet.</p>
      )}
      {viewer}
    </>
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

  const vm = state.data;
  const title = vmTitle(vm);
  return (
    <article>
      <title>{`${title} · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to="/">Catalog</Link>
      </nav>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
        <h1 className="h3 mb-0">{title}</h1>
        <EmulatorBadge emulatorType={vm.emulatorType} />
      </div>
      <p className="small text-body-secondary vm-identity">{vm.vmName}</p>
      {isAdmin ? (
        <p>
          <Link to={adminVmRoute(vm)} className="btn btn-sm btn-outline-primary">
            Manage this VM
          </Link>
        </p>
      ) : null}
      {vm.description ? <p className="vm-description">{vm.description}</p> : null}
      <PublicGallery title={title} gallery={vm.gallery} mainImage={vm.mainImage} />
    </article>
  );
}

export function VmDetailPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <MissingVm />;
  // Remounted for another VM, so that nothing from the previous one lingers.
  return (
    <VmDetail key={`${params.data.emulatorType}/${params.data.vmName}`} identity={params.data} />
  );
}
