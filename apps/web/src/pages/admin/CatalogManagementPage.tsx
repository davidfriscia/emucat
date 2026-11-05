import { adminMediaPath, adminVmRoute, vmTitle } from '@emucat/contracts';
import { useCallback } from 'react';
import { fetchAdminCatalog } from '../../api';
import {
  CatalogControls,
  Pagination,
  RegistrationNote,
  useCatalogFilters,
  VisibilityBadge,
  VmCard,
} from '../../components/Catalog';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useAsync } from '../../useAsync';

/** Every registered VM, public or not. Deliberately offers no way to create one. */
export function CatalogManagementPage() {
  const filters = useCatalogFilters();
  const { q, emulatorType, visibility, page, filtered, update } = filters;
  const load = useCallback(
    (signal: AbortSignal) => fetchAdminCatalog({ q, emulatorType, visibility, page }, signal),
    [q, emulatorType, visibility, page],
  );
  const { state, reload } = useAsync(load);

  return (
    <>
      <title>Manage · EmuCat</title>
      <h1 className="h3 mb-3">Manage the catalog</h1>
      <RegistrationNote />
      <CatalogControls filters={filters} showVisibility />
      {state.status === 'loading' ? <LoadingState label="Loading the catalog" /> : null}
      {state.status === 'error' ? (
        <ErrorState title="The catalog could not be loaded" error={state.error} onRetry={reload} />
      ) : null}
      {state.status === 'success' && state.data.items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="Nothing matches"
            action={
              <button
                type="button"
                className="btn btn-outline-primary"
                onClick={() => update({ q: undefined, emulator: undefined, visibility: undefined })}
              >
                Clear filters
              </button>
            }
          >
            No registered virtual machine matches your search and filters.
          </EmptyState>
        ) : (
          <EmptyState title="No registered virtual machines">
            Registration will become available through a connected local agent in a later milestone.
          </EmptyState>
        )
      ) : null}
      {state.status === 'success' && state.data.items.length > 0 ? (
        <>
          <div className="vm-grid">
            {state.data.items.map((vm) => (
              <VmCard
                key={`${vm.emulatorType}/${vm.vmName}`}
                to={adminVmRoute(vm)}
                title={vmTitle(vm)}
                emulatorType={vm.emulatorType}
                summary={vm.summary}
                imageSrc={vm.mainMediaId ? adminMediaPath(vm, vm.mainMediaId, 'thumbnail') : null}
                badges={<VisibilityBadge visibility={vm.visibility} />}
              />
            ))}
          </div>
          <Pagination
            pagination={state.data.pagination}
            onPage={(next) => update({ page: String(next) })}
          />
        </>
      ) : null}
    </>
  );
}
