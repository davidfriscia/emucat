import {
  publicVmRoute,
  VM_DESCRIPTION_MAX_LENGTH,
  VM_DISPLAY_NAME_MAX_LENGTH,
  vmPathParamsSchema,
  vmTitle,
  type AdminMediaListResponse,
  type AdminVmDetail,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiRequestError,
  fetchAdminVm,
  fetchVmMedia,
  updateVmMetadata,
  updateVmVisibility,
} from '../../api';
import { EmulatorBadge, VisibilityBadge } from '../../components/Catalog';
import { VmExecutionSection, type RunPreselection } from '../../components/Execution';
import { VmRestoreSection } from '../../components/Restore';
import { VmVersionsSection } from '../../components/Versions';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { VmMediaGrid } from '../../components/VmMediaGrid';
import { useAsync } from '../../useAsync';
import { NotFoundPage } from '../NotFoundPage';

function MetadataForm({
  vm,
  onSaved,
}: {
  vm: AdminVmDetail;
  onSaved: (vm: AdminVmDetail) => void;
}) {
  const [displayName, setDisplayName] = useState(vm.displayName ?? '');
  const [description, setDescription] = useState(vm.description ?? '');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await updateVmMetadata(vm, {
        displayName: displayName.trim() === '' ? null : displayName,
        description: description === '' ? null : description,
      });
      onSaved(updated);
      setSaved(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FormError error={error} />
      {saved ? (
        <div className="alert alert-success" role="status">
          Saved.
        </div>
      ) : null}
      <div className="mb-3">
        <label htmlFor="vm-display-name" className="form-label">
          Display name
        </label>
        <input
          id="vm-display-name"
          className="form-control"
          maxLength={VM_DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          aria-describedby="vm-display-name-help"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div id="vm-display-name-help" className="form-text">
          The title in the catalog. Without one, the catalog shows the VM name.
        </div>
      </div>
      <div className="mb-3">
        <label htmlFor="vm-description" className="form-label">
          Description
        </label>
        <textarea
          id="vm-description"
          className="form-control"
          rows={6}
          maxLength={VM_DESCRIPTION_MAX_LENGTH}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function VisibilityControl({
  vm,
  onChanged,
}: {
  vm: AdminVmDetail;
  onChanged: (vm: AdminVmDetail) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const target = vm.visibility === 'public' ? 'private' : 'public';

  const change = async () => {
    setError(null);
    setSubmitting(true);
    try {
      onChanged(await updateVmVisibility(vm, target));
    } catch (failure) {
      setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="d-flex flex-column align-items-stretch">
      <button
        type="button"
        className={`btn ${target === 'public' ? 'btn-primary' : 'btn-outline-danger'}`}
        disabled={submitting}
        aria-describedby="vm-visibility-text"
        onClick={() => void change()}
      >
        {target === 'public' ? 'Make public' : 'Make private'}
      </button>
      {error ? (
        <div className="mt-2">
          <FormError error={error} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Why the public catalog does or does not show a cover. Publication is the VM's alone, so the only things
 * that decide it are the VM's visibility and whether a main screenshot is selected.
 */
export function PublicCoverNotice({ vm }: { vm: AdminVmDetail }) {
  if (vm.visibility !== 'public') {
    return vm.mainMediaId ? null : (
      <p className="small text-body-secondary mt-2 mb-0">No main screenshot is selected yet.</p>
    );
  }
  if (vm.publicCover === 'shown') {
    return <p className="small mt-2 mb-0">The main screenshot is the public catalog’s cover.</p>;
  }
  return (
    <div className="alert alert-warning small mt-2 mb-0" role="status">
      <strong>No public cover.</strong> This VM is public, but no main screenshot is selected, so
      the public catalog shows a placeholder. Choose one below.
    </div>
  );
}

function VmEditor({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchAdminVm({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);
  const loadMedia = useCallback(
    (signal: AbortSignal) => fetchVmMedia({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const media = useAsync(loadMedia);
  // The version history chooses a version and mode in the run panel, which stays the one place to run.
  const [preselect, setPreselect] = useState<RunPreselection | null>(null);
  const runToken = useRef(0);

  // A change to a screenshot can change the VM's cover, and the server is what says how.
  const mediaChanged = (next: AdminMediaListResponse) => {
    media.setData(next);
    void fetchAdminVm({ emulatorType, vmName }).then(setData, () => undefined);
  };
  // And a change to the VM's visibility changes what the public sees of every screenshot.
  const visibilityChanged = (next: AdminVmDetail) => {
    setData(next);
    void fetchVmMedia({ emulatorType, vmName }).then(media.setData, () => undefined);
  };

  if (state.status === 'loading') return <LoadingState label="Loading the virtual machine" />;
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <EmptyState
          title="This virtual machine is not registered"
          action={
            <Link to="/admin/catalog" className="btn btn-outline-primary">
              Back to the catalog
            </Link>
          }
        >
          It may have a different name, or it may not have been registered yet.
        </EmptyState>
      );
    }
    return <ErrorState error={state.error} onRetry={reload} />;
  }

  const vm = state.data;
  return (
    <div className="page-wide vm-admin">
      <title>{`${vmTitle(vm)} · Manage · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to="/admin/catalog">Manage the catalog</Link>
      </nav>
      <header className="vm-admin-header mb-4">
        <div className="vm-admin-title">
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
        <div className="vm-admin-actions" role="group" aria-label="VM actions">
          <VisibilityControl vm={vm} onChanged={visibilityChanged} />
          <Link to="media" relative="path" className="btn btn-outline-primary">
            Manage media
          </Link>
          {vm.visibility === 'public' ? (
            <Link to={publicVmRoute(vm)} className="btn btn-outline-secondary theme-button">
              View public page
            </Link>
          ) : null}
        </div>
      </header>
      <div className="vm-admin-top mb-4">
        <section className="card" aria-labelledby="vm-metadata-heading">
          <div className="card-body">
            <h2 id="vm-metadata-heading" className="h6 card-title">
              Metadata
            </h2>
            <MetadataForm vm={vm} onSaved={setData} />
          </div>
        </section>
        <section className="card" aria-labelledby="vm-details-heading">
          <div className="card-body">
            <h2 id="vm-details-heading" className="h6 card-title">
              Details
            </h2>
            <p id="vm-visibility-text" className="small mb-0">
              {vm.visibility === 'public'
                ? 'Anyone can see this VM and all of its screenshots in the public catalog.'
                : 'Only signed-in administrators can see this VM and its screenshots. Making it public publishes all of its screenshots.'}
            </p>
            <PublicCoverNotice vm={vm} />
            <dl className="mt-3 mb-0 small settings-facts">
              <dt>Emulator</dt>
              <dd className="vm-identity">{vm.emulatorType}</dd>
              <dt>VM name</dt>
              <dd className="vm-identity">{vm.vmName}</dd>
              <dt>Versions</dt>
              <dd>{vm.versionCount}</dd>
              <dt>Media</dt>
              <dd>
                {vm.mediaCount === 1 ? '1 image' : `${vm.mediaCount} images`},{' '}
                {vm.mainMediaId ? 'a main image is selected' : 'no main image is selected'}
              </dd>
              <dt>Registered</dt>
              <dd>{new Date(vm.createdAt).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(vm.updatedAt).toLocaleString()}</dd>
            </dl>
            <p className="small text-body-secondary mt-2 mb-0">
              The identity is the VM&apos;s directory name and cannot be changed here. Renaming the
              directory makes it a different VM.
            </p>
          </div>
        </section>
      </div>
      <div className="vm-admin-panels">
        <VmExecutionSection vm={identity} preselect={preselect} />
        <VmRestoreSection vm={identity} />
        <VmVersionsSection
          vm={identity}
          onRun={(choice) => {
            runToken.current += 1;
            setPreselect({ ...choice, token: runToken.current });
          }}
        />
      </div>
      <section className="mt-4" aria-labelledby="vm-screenshots-heading">
        <h2 id="vm-screenshots-heading" className="h5">
          Screenshots
        </h2>
        {media.state.status === 'loading' ? <LoadingState label="Loading screenshots" /> : null}
        {media.state.status === 'error' ? (
          <p className="small text-body-secondary">
            The screenshots could not be loaded.{' '}
            <button type="button" className="btn btn-sm btn-link p-0" onClick={media.reload}>
              Try again
            </button>
          </p>
        ) : null}
        {media.state.status === 'success' && media.state.data.media.length === 0 ? (
          <p className="small text-body-secondary">
            No screenshots yet. They appear here shortly after the agent finds them.
          </p>
        ) : null}
        {media.state.status === 'success' && media.state.data.media.length > 0 ? (
          <VmMediaGrid vm={vm} media={media.state.data.media} onChange={mediaChanged} showMain />
        ) : null}
      </section>
    </div>
  );
}

export function VmEditorPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <NotFoundPage />;
  return <VmEditor identity={params.data} />;
}
