import { adminMediaPath, adminVmRoute, publicVmRoute, vmTitle } from '@emucat/contracts';
import { useCallback } from 'react';
import { fetchAdminCatalog, fetchAdminSummary } from '../../api';
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

/** How many VMs and screenshots there are, and how many of them the public sees. */
function CatalogSummary() {
  const load = useCallback((signal: AbortSignal) => fetchAdminSummary(signal), []);
  const { state } = useAsync(load);
  if (state.status !== 'success') return null;
  const { vms, media } = state.data;
  return (
    <dl className="catalog-summary small mb-3" aria-label="Catalog summary">
      <div>
        <dt>Virtual machines</dt>
        <dd>
          <span className="stat-value">{vms.total}</span>{' '}
          <span className="text-body-secondary">
            {vms.public} public, {vms.private} private
          </span>
        </dd>
      </div>
      <div>
        <dt>Media</dt>
        <dd>
          <span className="stat-value">{media.total}</span>{' '}
          <span className="text-body-secondary">
            {media.public} public, {media.private} private, by their VM
          </span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * The catalog as an administrator sees it: every registered VM, public or not. A public VM opens on its public page,
 * whose Manage this VM action leads to its management; a private one has no public page, so it opens there directly.
 * Deliberately offers no way to create a VM.
 */
export function AdminCatalog() {
  const filters = useCatalogFilters();
  const { q, emulatorType, visibility, page, filtered, update } = filters;
  const load = useCallback(
    (signal: AbortSignal) => fetchAdminCatalog({ q, emulatorType, visibility, page }, signal),
    [q, emulatorType, visibility, page],
  );
  const { state, reload } = useAsync(load);

  return (
    <>
      <title>Catalog · EmuCat</title>
      <h1 className="h3 mb-3">Catalog</h1>
      <CatalogSummary />
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
            To add one, run discovery on an agent from the Agents page, and choose Copy or Transfer.
          </EmptyState>
        )
      ) : null}
      {state.status === 'success' && state.data.items.length > 0 ? (
        <>
          <div className="vm-grid">
            {state.data.items.map((vm) => (
              <VmCard
                key={`${vm.emulatorType}/${vm.vmName}`}
                to={vm.visibility === 'public' ? publicVmRoute(vm) : adminVmRoute(vm)}
                title={vmTitle(vm)}
                emulatorType={vm.emulatorType}
                summary={vm.summary}
                tags={vm.tags}
                imageSrc={vm.mainMediaId ? adminMediaPath(vm, vm.mainMediaId, 'thumbnail') : null}
                badges={
                  <>
                    <VisibilityBadge visibility={vm.visibility} />
                    {vm.activeSessions > 0 ? (
                      <span className="badge text-bg-info">
                        <span className="visually-hidden">State: </span>Running
                      </span>
                    ) : null}
                    {vm.publicCover === 'no_main_image' ? (
                      <span className="badge text-bg-warning">No public cover</span>
                    ) : null}
                  </>
                }
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
