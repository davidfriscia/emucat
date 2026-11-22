import {
  publicVmRoute,
  VM_DESCRIPTION_MAX_LENGTH,
  VM_DISPLAY_NAME_MAX_LENGTH,
  type AdminVmDetail,
} from '@emucat/contracts';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { updateVmMetadata, updateVmVisibility } from '../../../api';
import { ClonedFrom } from '../../../components/Clone';
import { VirtualBoxExecutionSection, VmExecutionSection } from '../../../components/Execution';
import { FormError } from '../../../components/States';
import { TagSelector } from '../../../components/Tags';
import { vmSectionRoute } from '../../../navigation';
import { useVmManage } from './VmManageLayout';

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
      the public catalog shows a placeholder. Choose one under Screenshots.
    </div>
  );
}

/**
 * General: what the VM is, editing it, and running and verifying it. Run and Verify stay one panel, the only place
 * that runs the VM; the version history chooses a version there.
 */
export function VmGeneralPage() {
  const { identity, vm, title, setVm, preselect } = useVmManage();
  const { hash } = useLocation();
  // Links to a version used to point at this page; the versions are now in their own section.
  if (hash.startsWith('#version-')) {
    return <Navigate to={`${vmSectionRoute(identity, 'versions')}${hash}`} replace />;
  }

  return (
    <>
      <title>{`${title} · General · Manage · EmuCat`}</title>
      <div className="vm-admin-actions mb-4" role="group" aria-label="VM actions">
        <VisibilityControl vm={vm} onChanged={setVm} />
        {vm.visibility === 'public' ? (
          <Link to={publicVmRoute(vm)} className="btn btn-outline-secondary theme-button">
            View public page
          </Link>
        ) : null}
      </div>
      <div className="vm-admin-top mb-4">
        <section className="card" aria-labelledby="vm-metadata-heading">
          <div className="card-body">
            <h2 id="vm-metadata-heading" className="h6 card-title">
              Metadata
            </h2>
            <MetadataForm vm={vm} onSaved={setVm} />
            <hr />
            <TagSelector
              target={{ kind: 'vm', vm: identity }}
              value={vm.tags}
              onChange={(tags) => setVm({ ...vm, tags })}
              label="Tags"
              description="Saved as you change them. Shown in the catalog with the VM, and found by search. Screenshots and versions have their own tags."
            />
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
              {vm.clonedFrom ? <ClonedFrom provenance={vm.clonedFrom} /> : null}
              <dt>{vm.clonedFrom ? 'Created' : 'Registered'}</dt>
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
        {identity.emulatorType === 'virtualbox' ? (
          // Run in place only: never restored, and no remote mode (decision 0045).
          <VirtualBoxExecutionSection vm={identity} />
        ) : (
          <VmExecutionSection vm={identity} preselect={preselect} />
        )}
      </div>
    </>
  );
}
