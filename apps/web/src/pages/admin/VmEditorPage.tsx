import {
  publicVmRoute,
  VM_DESCRIPTION_MAX_LENGTH,
  VM_DISPLAY_NAME_MAX_LENGTH,
  vmPathParamsSchema,
  vmTitle,
  type AdminVmDetail,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ApiRequestError, fetchAdminVm, updateVmMetadata, updateVmVisibility } from '../../api';
import { EmulatorBadge, VisibilityBadge } from '../../components/Catalog';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
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
    <>
      <FormError error={error} />
      <p className="small">
        {vm.visibility === 'public'
          ? 'Anyone can see this VM in the public catalog.'
          : 'Only signed-in administrators can see this VM.'}
      </p>
      <button
        type="button"
        className={`btn ${target === 'public' ? 'btn-primary' : 'btn-outline-danger'}`}
        disabled={submitting}
        onClick={() => void change()}
      >
        {target === 'public' ? 'Make public' : 'Make private'}
      </button>
    </>
  );
}

function VmEditor({ identity }: { identity: VmIdentity }) {
  const { emulatorType, vmName } = identity;
  const load = useCallback(
    (signal: AbortSignal) => fetchAdminVm({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);

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
    <>
      <title>{`${vmTitle(vm)} · Manage · EmuCat`}</title>
      <nav aria-label="Breadcrumb" className="small mb-3">
        <Link to="/admin/catalog">Manage the catalog</Link>
      </nav>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">{vmTitle(vm)}</h1>
        <EmulatorBadge emulatorType={vm.emulatorType} />
        <VisibilityBadge visibility={vm.visibility} />
      </div>
      <div className="settings-grid">
        <section className="card">
          <div className="card-body">
            <h2 className="h6 card-title">Metadata</h2>
            <MetadataForm vm={vm} onSaved={setData} />
          </div>
        </section>
        <div className="d-flex flex-column gap-3">
          <section className="card">
            <div className="card-body">
              <h2 className="h6 card-title">Visibility</h2>
              <VisibilityControl vm={vm} onChanged={setData} />
              {vm.visibility === 'public' ? (
                <p className="small mt-2 mb-0">
                  <Link to={publicVmRoute(vm)}>View the public page</Link>
                </p>
              ) : null}
            </div>
          </section>
          <section className="card">
            <div className="card-body">
              <h2 className="h6 card-title">Media</h2>
              <p className="small">
                {vm.mediaCount === 1 ? '1 image.' : `${vm.mediaCount} images.`}{' '}
                {vm.mainMediaId ? 'A main image is selected.' : 'No main image is selected.'}
              </p>
              <Link to="media" relative="path" className="btn btn-outline-primary">
                Manage media
              </Link>
            </div>
          </section>
          <section className="card">
            <div className="card-body">
              <h2 className="h6 card-title">Identity</h2>
              <dl className="mb-0 small settings-facts">
                <dt>Emulator</dt>
                <dd className="vm-identity">{vm.emulatorType}</dd>
                <dt>VM name</dt>
                <dd className="vm-identity">{vm.vmName}</dd>
                <dt>Versions</dt>
                <dd>{vm.versionCount}</dd>
                <dt>Registered</dt>
                <dd>{new Date(vm.createdAt).toLocaleString()}</dd>
                <dt>Updated</dt>
                <dd>{new Date(vm.updatedAt).toLocaleString()}</dd>
              </dl>
              <p className="small text-body-secondary mt-2 mb-0">
                The identity is the VM&apos;s directory name and cannot be changed here. Renaming
                the directory makes it a different VM.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export function VmEditorPage() {
  const params = vmPathParamsSchema.safeParse(useParams());
  if (!params.success) return <NotFoundPage />;
  return <VmEditor identity={params.data} />;
}
