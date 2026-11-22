import { publicMediaPath, publicVmRoute, vmTitle } from '@emucat/contracts';
import { useCallback } from 'react';
import { fetchPublicCatalog } from '../api';
import { useAuth } from '../auth';
import { CatalogControls, Pagination, useCatalogFilters, VmCard } from '../components/Catalog';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../useAsync';
import { AdminCatalog } from './admin/AdminCatalog';

/**
 * The catalog: the application's first area, and the only way into a VM's management. Everyone else sees the public
 * catalog; an administrator sees every registered VM, public or private, and opens one to manage it.
 */
export function CatalogPage() {
  const { state } = useAuth();
  if (state.status === 'loading') return <LoadingState label="Loading the catalog" />;
  if (state.status === 'authenticated' && state.session.user.role === 'admin') {
    return <AdminCatalog />;
  }
  return <PublicCatalog />;
}

/** The public catalog. It works without signing in, and only ever shows public VMs. */
function PublicCatalog() {
  const filters = useCatalogFilters();
  const { q, emulatorType, page, filtered, update } = filters;
  const load = useCallback(
    (signal: AbortSignal) => fetchPublicCatalog({ q, emulatorType, page }, signal),
    [q, emulatorType, page],
  );
  const { state, reload } = useAsync(load);

  const noResults =
    state.status === 'success' &&
    state.data.items.length === 0 &&
    state.data.pagination.total === 0;
  // With nothing registered and no filter applied, search controls would have nothing to offer.
  const nothingAtAll = noResults && !filtered;

  return (
    <>
      <title>Catalog · EmuCat</title>
      <h1 className="h3 mb-3">Catalog</h1>
      {nothingAtAll ? null : <CatalogControls filters={filters} />}
      {state.status === 'loading' ? <LoadingState label="Loading the catalog" /> : null}
      {state.status === 'error' ? (
        <ErrorState title="The catalog could not be loaded" error={state.error} onRetry={reload} />
      ) : null}
      {nothingAtAll ? (
        <EmptyState title="No virtual machines yet">
          Nothing has been published to this catalog so far. Virtual machines appear here once they
          have been registered from a connected EmuCat agent and made public.
        </EmptyState>
      ) : null}
      {noResults && filtered ? (
        <EmptyState
          title="Nothing matches"
          action={
            <button
              type="button"
              className="btn btn-outline-primary"
              onClick={() => update({ q: undefined, emulator: undefined })}
            >
              Clear filters
            </button>
          }
        >
          No public virtual machine matches your search and filters.
        </EmptyState>
      ) : null}
      {state.status === 'success' && state.data.items.length > 0 ? (
        <>
          <div className="vm-grid">
            {state.data.items.map((vm) => (
              <VmCard
                key={`${vm.emulatorType}/${vm.vmName}`}
                to={publicVmRoute(vm)}
                title={vmTitle(vm)}
                emulatorType={vm.emulatorType}
                summary={vm.summary}
                tags={vm.tags}
                imageSrc={vm.mainImage ? publicMediaPath(vm.mainImage.id, 'thumbnail') : null}
              />
            ))}
          </div>
          <Pagination
            pagination={state.data.pagination}
            onPage={(next) => update({ page: String(next) })}
          />
        </>
      ) : null}
      {state.status === 'success' && state.data.items.length === 0 && !noResults ? (
        <EmptyState
          title="This page is empty"
          action={
            <button
              type="button"
              className="btn btn-outline-primary"
              onClick={() => update({ page: undefined })}
            >
              Back to the first page
            </button>
          }
        >
          There are fewer pages than that now.
        </EmptyState>
      ) : null}
    </>
  );
}
