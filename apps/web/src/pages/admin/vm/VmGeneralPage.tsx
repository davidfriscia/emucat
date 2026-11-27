import {
  EMULATOR_LABELS,
  publicVmRoute,
  VM_DESCRIPTION_MAX_LENGTH,
  VM_DISPLAY_NAME_MAX_LENGTH,
  type AdminVmDetail,
} from '@emucat/contracts';
import {
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Image,
  Info,
  Lock,
  PencilLine,
  Save,
} from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { updateVmMetadata, updateVmVisibility } from '../../../api';
import { ClonedFrom } from '../../../components/Clone';
import { VirtualBoxExecutionSection, VmExecutionSection } from '../../../components/Execution';
import {
  OperationNotices,
  OperationsSummary,
} from '../../../components/operations/OperationStatus';
import { FormError } from '../../../components/States';
import { TagSelector } from '../../../components/Tags';
import {
  ICON_SIZE,
  IconButton,
  IconLink,
  Toolbar,
  ToolbarGroup,
  ToolbarSpacer,
} from '../../../components/ui/IconButton';
import { InfoPopover } from '../../../components/ui/Popover';
import { StatusChip } from '../../../components/ui/StatusChip';
import { vmSectionRoute } from '../../../navigation';
import { useVmManage } from './VmManageLayout';

/**
 * General (decision 0060): the VM's toolbar (publication, its operations, its information), the metadata editor, and
 * Run and verify. Read-only facts are in the VM's Info panel; editable fields stay on the page.
 */

const VISIBILITY_TEXT = {
  public: 'Anyone can see this VM and all of its screenshots in the public catalog.',
  private:
    'Only signed-in administrators can see this VM and its screenshots. Making it public publishes all of its screenshots.',
} as const;

/**
 * Display name and description, saved together and only when asked, exactly as before. The form says when it holds
 * changes the server does not have yet.
 */
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
  const headingId = useId();
  const dirty = displayName !== (vm.displayName ?? '') || description !== (vm.description ?? '');

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
      // What the server kept: a blank name is cleared, so the field shows what is saved.
      setDisplayName(updated.displayName ?? '');
      setDescription(updated.description ?? '');
      setSaved(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-labelledby={headingId}>
      <div className="vm-section-header">
        <h2 id={headingId} className="vm-section-title">
          <PencilLine size={ICON_SIZE + 2} aria-hidden="true" />
          Metadata
        </h2>
        <Toolbar label="Metadata actions" className="vm-section-actions">
          {dirty ? (
            <StatusChip
              icon={PencilLine}
              tone="warning"
              label="Unsaved changes"
              detail="The display name or description differs from what is saved. Save to keep it."
            />
          ) : saved ? (
            <span role="status">
              <StatusChip icon={CircleCheck} tone="success" label="Saved" />
            </span>
          ) : null}
          <IconButton
            type="submit"
            icon={Save}
            label="Save metadata"
            text="Save"
            variant="primary"
            tooltipPlacement="start"
            loading={submitting}
            disabled={submitting}
          />
        </Toolbar>
      </div>
      <FormError error={error} />
      <div className="vm-metadata-fields">
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
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
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
            rows={5}
            maxLength={VM_DESCRIPTION_MAX_LENGTH}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setSaved(false);
            }}
          />
        </div>
      </div>
    </form>
  );
}

/** Makes the VM public or private, at once, as it always did. The consequence is the button's description. */
function VisibilityControl({
  vm,
  onChanged,
  onError,
}: {
  vm: AdminVmDetail;
  onChanged: (vm: AdminVmDetail) => void;
  onError: (error: unknown) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const target = vm.visibility === 'public' ? 'private' : 'public';
  const descriptionId = useId();

  const change = async () => {
    onError(null);
    setSubmitting(true);
    try {
      onChanged(await updateVmVisibility(vm, target));
    } catch (failure) {
      onError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <IconButton
        icon={target === 'public' ? Eye : EyeOff}
        label={target === 'public' ? 'Make public' : 'Make private'}
        tooltip={target === 'public' ? 'Make public, with all its screenshots' : 'Make private'}
        danger={target === 'private'}
        loading={submitting}
        disabled={submitting}
        aria-describedby={descriptionId}
        onClick={() => void change()}
      />
      <span id={descriptionId} className="visually-hidden">
        {VISIBILITY_TEXT[vm.visibility]}
      </span>
    </>
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

/** Everything the Details panel used to show, on demand: publication, identity, contents and history. */
function VmInfo({ vm }: { vm: AdminVmDetail }) {
  return (
    <>
      <h4 className="info-section">Publication</h4>
      <p className="mb-1">
        {vm.visibility === 'public' ? 'Public. ' : 'Private. '}
        {VISIBILITY_TEXT[vm.visibility]}
      </p>
      {vm.visibility === 'public' && vm.publicCover !== 'shown' ? (
        <p className="mb-0">
          No main screenshot is selected, so the public catalog shows a placeholder.
        </p>
      ) : (
        <PublicCoverNotice vm={vm} />
      )}
      <h4 className="info-section">Identity</h4>
      <dl className="info-facts">
        <dt>Emulator</dt>
        <dd>
          <span className="vm-identity">{vm.emulatorType}</span> ({EMULATOR_LABELS[vm.emulatorType]}
          )
        </dd>
        <dt>VM name</dt>
        <dd>
          <code className="vm-identity info-copyable">{vm.vmName}</code>
        </dd>
      </dl>
      <p className="info-note mt-1 mb-0">
        The identity is the VM&apos;s directory name and cannot be changed here. Renaming the
        directory makes it a different VM.
      </p>
      <h4 className="info-section">Contents</h4>
      <dl className="info-facts">
        <dt>Versions</dt>
        <dd>{vm.versionCount}</dd>
        <dt>Media</dt>
        <dd>
          {vm.mediaCount === 1 ? '1 image' : `${vm.mediaCount} images`},{' '}
          {vm.mainMediaId ? 'a main image is selected' : 'no main image is selected'}
        </dd>
      </dl>
      <h4 className="info-section">History</h4>
      <dl className="info-facts">
        {vm.clonedFrom ? <ClonedFrom provenance={vm.clonedFrom} /> : null}
        <dt>{vm.clonedFrom ? 'Created' : 'Registered'}</dt>
        <dd>{new Date(vm.createdAt).toLocaleString()}</dd>
        <dt>Updated</dt>
        <dd>{new Date(vm.updatedAt).toLocaleString()}</dd>
      </dl>
    </>
  );
}

/**
 * General: what the VM is, editing it, and running and verifying it. Run and Verify stay one panel, the only place
 * that runs the VM; the version history chooses a version there.
 */
export function VmGeneralPage() {
  const { identity, vm, title, setVm, preselect } = useVmManage();
  const { hash } = useLocation();
  const [visibilityError, setVisibilityError] = useState<unknown>(null);
  // Links to a version used to point at this page; the versions are now in their own section.
  if (hash.startsWith('#version-')) {
    return <Navigate to={`${vmSectionRoute(identity, 'versions')}${hash}`} replace />;
  }
  const isPublic = vm.visibility === 'public';

  return (
    <>
      <title>{`${title} · General · Manage · EmuCat`}</title>
      <Toolbar label="VM actions" className="vm-general-toolbar">
        <ToolbarGroup label="Publication">
          <StatusChip
            icon={isPublic ? Globe : Lock}
            tone={isPublic ? 'success' : 'neutral'}
            label={isPublic ? 'Public' : 'Private'}
            detail={VISIBILITY_TEXT[vm.visibility]}
          />
          {isPublic && vm.publicCover === 'shown' ? (
            <StatusChip
              icon={Image}
              label="Cover shown"
              detail="The main screenshot is the public catalog’s cover."
            />
          ) : null}
          <VisibilityControl vm={vm} onChanged={setVm} onError={setVisibilityError} />
          {isPublic ? (
            <IconLink icon={ExternalLink} label="View public page" to={publicVmRoute(vm)} />
          ) : null}
        </ToolbarGroup>
        <ToolbarSpacer />
        <OperationsSummary />
        <InfoPopover
          icon={Info}
          label="VM information"
          tooltip="VM information"
          tooltipPlacement="start"
          title={title}
          wide
        >
          {() => <VmInfo vm={vm} />}
        </InfoPopover>
      </Toolbar>
      <FormError error={visibilityError} />
      {/* A problem that needs a person stays in view, never only behind Info. */}
      {isPublic && vm.publicCover !== 'shown' ? (
        <div className="mb-3">
          <PublicCoverNotice vm={vm} />
        </div>
      ) : null}
      <OperationNotices />
      <section className="card vm-general-metadata mb-4">
        <div className="card-body">
          <MetadataForm key={`${vm.emulatorType}/${vm.vmName}`} vm={vm} onSaved={setVm} />
          <TagSelector
            target={{ kind: 'vm', vm: identity }}
            value={vm.tags}
            onChange={(tags) => setVm({ ...vm, tags })}
            label="Tags"
            description="Saved as you change them. Shown in the catalog with the VM, and found by search. Screenshots and versions have their own tags."
          />
        </div>
      </section>
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
