import { adminVmRoute, publicMediaPath, vmPathParamsSchema, vmTitle } from '@emucat/contracts';
import type { VmIdentity } from '@emucat/contracts';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { ApiRequestError, fetchPublicVm } from '../api';
import { useAuth } from '../auth';
import { EmulatorBadge, VmImage } from '../components/Catalog';
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

function VmDetail({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchPublicVm({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload } = useAsync(load);
  const { state: auth } = useAuth();

  if (state.status === 'loading') return <LoadingState label="Loading the virtual machine" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) return <MissingVm />;
    return <ErrorState error={state.error} onRetry={reload} />;
  }

  const vm = state.data;
  const title = vmTitle(vm);
  const others = vm.gallery.filter((item) => item.id !== vm.mainImage?.id);
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
      {auth.status === 'authenticated' && auth.session.user.role === 'admin' ? (
        <p>
          <Link to={adminVmRoute(vm)} className="btn btn-sm btn-outline-primary">
            Manage this VM
          </Link>
        </p>
      ) : null}
      <div className="vm-detail-media rounded-3 overflow-hidden border mb-3">
        <VmImage
          src={vm.mainImage ? publicMediaPath(vm.mainImage.id, 'full') : null}
          alt={`Screenshot of ${title}`}
          markSize={96}
        />
      </div>
      {vm.description ? <p className="vm-description">{vm.description}</p> : null}
      {others.length > 0 ? (
        <section className="mt-4">
          <h2 className="h5">More images</h2>
          <div className="gallery-grid">
            {others.map((item, index) => (
              <a
                key={item.id}
                href={publicMediaPath(item.id, 'full')}
                className="rounded-2 overflow-hidden border d-block"
              >
                <VmImage
                  src={publicMediaPath(item.id, 'thumbnail')}
                  alt={`Screenshot ${index + 1} of ${title}`}
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

export function VmDetailPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <MissingVm />;
  return <VmDetail identity={params.data} />;
}
