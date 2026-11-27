import { useCaptureGalleryRefresh } from '../../../components/CaptureScreenshot';
import { vmTitle, type AdminVmDetail, type VmIdentity } from '@emucat/contracts';
import { ArrowLeft } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link, matchPath, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiRequestError, fetchAdminVm } from '../../../api';
import { EmulatorBadge, VisibilityBadge } from '../../../components/Catalog';
import type { RunPreselection } from '../../../components/Execution';
import { SidebarLayout } from '../../../components/SidebarLayout';
import { EmptyState, ErrorState, LoadingState } from '../../../components/States';
import { VirtualBoxManagementProvider } from '../../../components/VirtualBoxSource';
import { VmOperationsProvider } from '../../../components/operations/VmOperationsProvider';
import {
  CATALOG_PATH,
  useVmRouteIdentity,
  vmManageNavItems,
  vmSectionRoute,
} from '../../../navigation';
import { useAsync } from '../../../useAsync';
import { NotFoundPage } from '../../NotFoundPage';

/** What every section of a VM's management shares: the VM, and the one place to run it. */
interface VmManageContextValue {
  identity: VmIdentity;
  vm: AdminVmDetail;
  title: string;
  /** Adopts the VM as the server returned it after a change. */
  setVm: (vm: AdminVmDetail) => void;
  /** Reads the VM again, for changes made elsewhere that alter it, such as its cover. */
  refreshVm: () => void;
  /** What the version history last asked the run panel to choose. */
  preselect: RunPreselection | null;
  /** Chooses a version and mode in the run panel, under General, and goes there. */
  requestRun: (choice: Omit<RunPreselection, 'token'>) => void;
}

const VmManageContext = createContext<VmManageContextValue | null>(null);

export function useVmManage(): VmManageContextValue {
  const value = useContext(VmManageContext);
  if (!value) throw new Error('useVmManage must be used inside VmManageLayout');
  return value;
}

function BackToCatalog() {
  return (
    <Link to={CATALOG_PATH} className="sidebar-back small">
      <ArrowLeft size={14} aria-hidden="true" className="sidebar-back-icon" />
      Back to Catalog
    </Link>
  );
}

function VmHeader({ vm }: { vm: AdminVmDetail }) {
  return (
    <header className="vm-admin-header mb-4">
      <div className="vm-admin-title">
        <p className="small text-body-secondary mb-1">Manage</p>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <h1 className="h3 mb-0">{vmTitle(vm)}</h1>
          <EmulatorBadge emulatorType={vm.emulatorType} />
          <VisibilityBadge visibility={vm.visibility} />
        </div>
        <p className="small text-body-secondary mb-0 mt-1">
          <span className="vm-identity">{vm.vmName}</span> ·{' '}
          {vm.versionCount === 1 ? '1 version' : `${vm.versionCount} versions`} ·{' '}
          {vm.mediaCount === 1 ? '1 image' : `${vm.mediaCount} images`}
        </p>
      </div>
    </header>
  );
}

function VmManage({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchAdminVm({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);
  const refreshVm = useCallback(() => {
    void fetchAdminVm({ emulatorType, vmName }).then(setData, () => undefined);
  }, [emulatorType, vmName, setData]);
  // A screenshot taken from the run panel changes the VM's image count, whichever section is open.
  useCaptureGalleryRefresh({ emulatorType, vmName }, refreshVm);
  const [preselect, setPreselect] = useState<RunPreselection | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const items = useMemo(() => vmManageNavItems({ emulatorType, vmName }), [emulatorType, vmName]);
  const current = items.find((item) =>
    matchPath({ path: item.to, end: item.end ?? false }, pathname),
  );

  const requestRun = useCallback(
    (choice: Omit<RunPreselection, 'token'>) => {
      // A new token each time, so that choosing the same version again still applies.
      setPreselect((previous) => ({ ...choice, token: (previous?.token ?? 0) + 1 }));
      void navigate(vmSectionRoute({ emulatorType, vmName }, 'general'));
    },
    [emulatorType, vmName, navigate],
  );

  const value = useMemo<VmManageContextValue | null>(
    () =>
      state.status === 'success'
        ? {
            identity: { emulatorType, vmName },
            vm: state.data,
            title: vmTitle(state.data),
            setVm: setData,
            refreshVm,
            preselect,
            requestRun,
          }
        : null,
    [state, emulatorType, vmName, setData, refreshVm, preselect, requestRun],
  );

  if (state.status === 'loading') return <LoadingState label="Loading the virtual machine" />;
  if (state.status === 'error' || !value) {
    if (
      state.status === 'error' &&
      state.error instanceof ApiRequestError &&
      state.error.status === 404
    ) {
      return (
        <EmptyState
          title="This virtual machine is not registered"
          action={
            <Link to={CATALOG_PATH} className="btn btn-outline-primary">
              Back to Catalog
            </Link>
          }
        >
          It may have a different name, or it may not have been registered yet.
        </EmptyState>
      );
    }
    return <ErrorState error={state.status === 'error' ? state.error : null} onRetry={reload} />;
  }

  let content: ReactNode = <Outlet />;
  if (emulatorType === 'virtualbox') {
    // The machine is polled once, for every part of every section that shows it.
    content = (
      <VirtualBoxManagementProvider vm={value.identity}>{content}</VirtualBoxManagementProvider>
    );
  }
  // The VM's operations are followed once, for General and Version History alike (decision 0060). One that ends can
  // change the VM's version count.
  content = (
    <VmOperationsProvider vm={value.identity} onEnded={refreshVm}>
      {content}
    </VmOperationsProvider>
  );
  return (
    <VmManageContext.Provider value={value}>
      <SidebarLayout
        id="vm-sidebar"
        label="VM"
        header={
          <>
            <BackToCatalog />
            {/* On a narrow screen the page's own heading, right below, already names the VM. */}
            <div className="sidebar-vm mt-2 d-none d-lg-block">
              <span className="visually-hidden">Managing </span>
              <strong className="sidebar-vm-title">{value.title}</strong>
              <span className="small text-body-secondary vm-identity d-block">{vmName}</span>
            </div>
          </>
        }
        items={items}
        currentLabel={current?.label}
      >
        <div className="vm-admin">
          <VmHeader vm={value.vm} />
          {content}
        </div>
      </SidebarLayout>
    </VmManageContext.Provider>
  );
}

/**
 * A VM's management, for administrators only: the VM's own sidebar of sections, and the section chosen in it. It is
 * reached from the catalog. The API checks every request it makes, whatever this page shows.
 */
export function VmManageLayout() {
  const identity = useVmRouteIdentity();
  if (!identity) return <NotFoundPage />;
  // Remounted for another VM, so that nothing from the previous one lingers.
  return <VmManage key={`${identity.emulatorType}/${identity.vmName}`} identity={identity} />;
}
