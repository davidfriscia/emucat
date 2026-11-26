import {
  buildVersionTree,
  type ExecutionMode,
  type RegistrationOperation,
  type RemoteSession,
  type RestoreOptionsResponse,
  type VersionNode,
  type VersionTreeEntry,
  type VirtualBoxManagementResponse,
  type VmIdentity,
} from '@emucat/contracts';
import {
  ArrowUpToLine,
  Camera,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  FolderOpen,
  GitBranch,
  HardDriveDownload,
  HardDriveUpload,
  History,
  Import,
  Info,
  Layers,
  Link2,
  Monitor,
  MonitorCog,
  Pencil,
  Play,
  RefreshCw,
  ServerOff,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Tags,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import {
  discardWorkspace,
  fetchRemasters,
  fetchRestoreOptions,
  fetchVersionTree,
  fetchWorkspaces,
  launchWorkspace,
  preserveWorkspace,
  retrySnapshotDeletion,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { DeleteSnapshotDialog, deletionReasonText } from './Cleanup';
import { ArchiveExplorerDialog } from './ArchiveExplorer';
import { CloneProgress, CloneVmDialog } from './Clone';
import { ConfirmDialog } from './Dialogs';
import { VmLaunchDialog, WORKSPACE_STATE_TEXT, type RunPreselection } from './Execution';
import {
  EditVersionDetailsDialog,
  LocalRemasterDialog,
  PromoteSnapshotDialog,
  RemasterProgress,
  type RemasterSourceChoice,
} from './Remaster';
import { RestoreDialog } from './Restore';
import {
  CreateSnapshotDialog,
  shortId,
  SnapshotProgress,
  versionLabel,
  type SnapshotRequest,
} from './Snapshots';
import { FormError } from './States';
import { TagEditorDialog, TagList } from './Tags';
import {
  ICON_SIZE,
  IconButton,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
} from './ui/IconButton';
import { InfoPopover } from './ui/Popover';
import { StatusChip } from './ui/StatusChip';
import {
  ImportIntoVirtualBoxDialog,
  notifyVirtualBoxChanged,
  VIRTUALBOX_IDLE_POLL_MS,
  WithVirtualBoxManagement,
} from './VirtualBoxSource';

/**
 * A VM's version history: an immutable master and its snapshots, drawn as the tree they are, with what
 * can be done with each. Administrators only (decision 0039). Nothing here can name a path, a repository
 * or an archive: every action names a version, an agent, or a working copy.
 */

const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;

function newRequestId(): string {
  return crypto.randomUUID();
}

/** What the agent verified, said plainly: the server never reads an archive itself. */
function verificationText(node: VersionNode): string {
  if (node.deletion) return 'Being deleted, so it can no longer be restored, run or snapshotted';
  if (!node.available) return 'Repository disabled, so it cannot be restored now';
  return node.manifest
    ? `Verified by the agent when published: ${node.manifest.fileCount} files, ${formatBytes(node.manifest.totalUncompressedBytes)}`
    : 'Archive hash recorded; manifest details not recorded';
}

function holderText(holder: VersionNode['holders'][number]): string {
  if (holder.kind === 'workspace') return `Temporary or working copy on ${holder.agentName}`;
  const status =
    holder.contentStatus === 'verified'
      ? 'verified'
      : holder.contentStatus === 'modified'
        ? 'modified since'
        : 'not verified since it reconnected';
  return `Local copy on ${holder.agentName} (${status})`;
}

/** The compact indicator of one agent's copy. Its full statement is {@link holderText}. */
function HolderChip({ holder }: { holder: VersionNode['holders'][number] }) {
  const detail = holderText(holder);
  if (holder.kind === 'workspace') {
    return (
      <StatusChip icon={MonitorCog} label={`Working copy · ${holder.agentName}`} detail={detail} />
    );
  }
  if (holder.contentStatus === 'verified') {
    return (
      <StatusChip
        icon={Monitor}
        tone="success"
        label={`Local · ${holder.agentName}`}
        detail={detail}
      />
    );
  }
  return (
    <StatusChip
      icon={ShieldAlert}
      tone="warning"
      label={`Local · ${holder.agentName} · ${holder.contentStatus === 'modified' ? 'modified' : 'not verified'}`}
      detail={detail}
    />
  );
}

/** The compact indicator of what is known about the archive itself. Its full statement is {@link verificationText}. */
function ArchiveChip({ node }: { node: VersionNode }) {
  const detail = verificationText(node);
  if (node.deletion)
    return <StatusChip icon={Trash2} tone="danger" label="Being deleted" detail={detail} />;
  if (!node.available) {
    return (
      <StatusChip icon={ServerOff} tone="warning" label="Repository disabled" detail={detail} />
    );
  }
  // Historical: what the agent checked when it published the archive, not the archive's or a copy's state today.
  return node.manifest ? (
    <StatusChip icon={ShieldCheck} tone="success" label="Verified when published" detail={detail} />
  ) : (
    <StatusChip icon={ShieldQuestion} label="Hash recorded" detail={detail} />
  );
}

const EXECUTION_GROUP = 'Run and restore';
const MANAGEMENT_GROUP = 'Version management';
const LIFECYCLE_GROUP = 'Lifecycle';

/** One version, with its children nested under it. A list inside a list is what keeps branches visible. */
function VersionItem({
  entry,
  vm,
  nameOf,
  labelOf,
  restoreOptions,
  onRestore,
  onSnapshot,
  onRun,
  onDelete,
  onRetryDelete,
  virtualbox,
  onImport,
  onEditDetails,
  onEditTags,
  onPromote,
  onClone,
  onViewContents,
}: {
  entry: VersionTreeEntry;
  /** Opens View Archive Contents (decision 0055). */
  onViewContents: (node: VersionNode) => void;
  /** Opens the dialog that clones this version into a new VM (decision 0052). */
  onClone: (node: VersionNode) => void;
  onEditDetails: (node: VersionNode) => void;
  onEditTags: (node: VersionNode) => void;
  onPromote: (node: VersionNode) => void;
  vm: VmIdentity;
  /** For a VirtualBox VM, its machine and agents; `null` while unknown or for another emulator. */
  virtualbox: VirtualBoxManagementResponse | null;
  onImport: (node: VersionNode) => void;
  /** The version's name for assistive technology: unique in the tree, even when labels repeat. */
  nameOf: (node: VersionNode) => string;
  /** Another version's label, by its identifier, or `null` when it is not in the history. */
  labelOf: (id: string) => string | null;
  restoreOptions: RestoreOptionsResponse | null;
  onRestore: (versionId: string) => void;
  onSnapshot: (node: VersionNode, agentId: string, agentName: string) => void;
  onRun: (node: VersionNode, mode: ExecutionMode) => void;
  onDelete: (node: VersionNode) => void;
  onRetryDelete: (node: VersionNode) => void;
}) {
  const { node, depth, children } = entry;
  const name = nameOf(node);
  const deleteReason = deletionReasonText(node);
  const [expanded, setExpanded] = useState(true);
  const headingId = `version-${node.id}`;
  const canRestore = node.available && (restoreOptions?.agents.some((a) => a.online) ?? false);
  const localHolders = node.holders.filter((holder) => holder.kind === 'local');
  // An OVA is imported into VirtualBox as a new machine, never restored over one, and a VirtualBox VM has no
  // remote mode. A snapshot is a new OVA of the linked machine, made from the version it comes from (decision 0046).
  const isVirtualBox = vm.emulatorType === 'virtualbox';
  const source = virtualbox?.source ?? null;
  const lineage = virtualbox?.sourceVersionId ?? null;
  const snapshotParent =
    source !== null && (lineage === null ? node.kind === 'master' : lineage === node.id);
  const importer = virtualbox?.agents.some((agent) => agent.management && agent.online) ?? false;
  const virtualBoxBusy =
    virtualbox?.operations.some((item) => item.state === 'queued' || item.state === 'running') ??
    false;
  const title = node.title ?? versionLabel(node);
  const KindIcon = node.kind === 'master' ? Layers : Camera;

  // Why each action that is shown cannot be used now. The conditions are the ones the buttons always had; these only
  // say them. `null`: available.
  const unusable = node.deletion
    ? 'It is being deleted.'
    : 'Its repository is disabled, so it cannot be used now.';
  const restoreReason = canRestore
    ? null
    : !node.available
      ? unusable
      : restoreOptions === null
        ? 'The agents that could restore it are not known yet.'
        : 'No agent is online to restore it.';
  const availableReason = node.available ? null : unusable;
  const importDisabled = !node.available || node.deletion !== null || !importer || virtualBoxBusy;
  const importReason = !importDisabled
    ? null
    : !node.available || node.deletion !== null
      ? unusable
      : !importer
        ? 'No online agent can import into VirtualBox.'
        : 'Another VirtualBox operation is in progress.';
  const machineSnapshotDisabled =
    source === null ||
    !node.available ||
    node.deletion !== null ||
    virtualBoxBusy ||
    source.state !== 'powered_off' ||
    !source.agentOnline;
  const machineSnapshotReason =
    source === null || !machineSnapshotDisabled
      ? null
      : !node.available || node.deletion !== null
        ? unusable
        : virtualBoxBusy
          ? 'Another VirtualBox operation is in progress.'
          : source.state !== 'powered_off'
            ? 'Power the machine off to create a snapshot.'
            : `${source.agentName} is offline.`;
  const showDelete = node.kind === 'snapshot' && !node.deletion;
  const restrictions: [string, string][] = [];
  if (!isVirtualBox) {
    if (restoreReason) restrictions.push(['Restore', restoreReason]);
    if (availableReason) restrictions.push(['Run', availableReason]);
  } else {
    if (importReason) restrictions.push(['Import into VirtualBox', importReason]);
    if (snapshotParent && machineSnapshotReason)
      restrictions.push(['Create snapshot', machineSnapshotReason]);
  }
  if (!node.deletion && availableReason)
    restrictions.push(['Clone and view contents', availableReason]);
  if (showDelete && deleteReason && !node.deletable.eligible)
    restrictions.push(['Delete snapshot', deleteReason]);

  const parentLabel = node.parentVersionId ? labelOf(node.parentVersionId) : null;

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-labelledby={headingId}
      aria-expanded={children.length > 0 ? expanded : undefined}
      className="version-node"
    >
      <div className={`version-card version-card-${node.kind}`}>
        <div className="version-card-head">
          {children.length > 0 ? (
            <IconButton
              icon={expanded ? ChevronDown : ChevronRight}
              label={expanded ? `Collapse ${name}` : `Expand ${name}`}
              tooltip={expanded ? 'Collapse branch' : 'Expand branch'}
              className="version-toggle"
              onClick={() => setExpanded((value) => !value)}
            />
          ) : (
            <span className="version-toggle-space" aria-hidden="true" />
          )}
          <KindIcon size={ICON_SIZE} aria-hidden="true" className="version-kind-icon" />
          <div className="version-identity">
            <h4 id={headingId} className="version-title">
              {title}
            </h4>
            {node.title ? (
              <span className="small text-body-secondary version-label">{versionLabel(node)}</span>
            ) : null}
            <span className={`version-kind version-kind-${node.kind}`}>
              {node.kind === 'master' ? 'Master' : 'Snapshot'}
            </span>
          </div>
          <span className="small text-body-secondary vm-identity version-id" title={node.id}>
            {shortId(node.id)}
          </span>
        </div>
        <div className="version-summary">
          <span className="version-summary-text">
            {formatTime(node.createdAt)} · {formatBytes(node.archiveSizeBytes)}
          </span>
          <ArchiveChip node={node} />
          {node.promotedAt ? (
            <StatusChip
              icon={ArrowUpToLine}
              label="Promoted"
              detail={`Promoted from a snapshot ${formatTime(node.promotedAt)}`}
            />
          ) : null}
          {source && lineage === node.id ? (
            <StatusChip
              icon={Link2}
              label="Linked machine"
              detail="The linked machine comes from this version."
            />
          ) : null}
          {children.length > 1 ? (
            <StatusChip icon={GitBranch} label={`${children.length} branches`} />
          ) : null}
          {node.holders.map((holder) => (
            <HolderChip
              key={`${holder.agentId}/${holder.workspaceId ?? 'local'}`}
              holder={holder}
            />
          ))}
          <TagList tags={node.tags} label={`Tags of ${name}`} className="version-tags" />
        </div>
        {node.deletion ? (
          // Kept in view: an action is under way, and a failure may need a person.
          <div className="small version-alert" role="status">
            Deletion requested {formatTime(node.deletion.requestedAt)}; an agent configured for{' '}
            {node.repositoryName} deletes its archive, and the snapshot then leaves the history.
            {node.deletion.error ? (
              <div className="alert alert-warning small mb-0 mt-1">
                The last attempt failed (
                <span className="vm-identity">{node.deletion.error.code}</span>):{' '}
                {node.deletion.error.message} It is tried again automatically.
                <div className="mt-1">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary theme-button"
                    aria-label={`Retry deleting ${name} now`}
                    onClick={() => onRetryDelete(node)}
                  >
                    Retry now
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <Toolbar label={`Actions for ${name}`} className="version-toolbar">
          <ToolbarGroup label={EXECUTION_GROUP}>
            {isVirtualBox ? (
              <>
                <IconButton
                  icon={Import}
                  label={`Import ${name} into VirtualBox`}
                  tooltip="Import into VirtualBox"
                  aria-haspopup="dialog"
                  disabled={importDisabled}
                  disabledReason={importReason}
                  onClick={() => onImport(node)}
                />
                {snapshotParent && source ? (
                  <IconButton
                    icon={Camera}
                    label={`Create snapshot of ${source.displayName} from ${name}`}
                    tooltip={`Create snapshot of ${source.displayName}`}
                    disabled={machineSnapshotDisabled}
                    disabledReason={machineSnapshotReason}
                    onClick={() => onSnapshot(node, source.agentId, source.agentName)}
                  />
                ) : null}
              </>
            ) : (
              <>
                <IconButton
                  icon={HardDriveDownload}
                  label={`Restore ${name}`}
                  tooltip="Restore version"
                  aria-haspopup="dialog"
                  disabled={!canRestore}
                  disabledReason={restoreReason}
                  onClick={() => onRestore(node.id)}
                />
                <IconButton
                  icon={Play}
                  label={`Run ${name} in Remote Volatile`}
                  tooltip="Run volatile"
                  disabled={!node.available}
                  disabledReason={availableReason}
                  onClick={() => onRun(node, 'remote_volatile')}
                />
                <IconButton
                  icon={Camera}
                  label={`Run ${name} in Remote Snapshot`}
                  tooltip="Run and snapshot"
                  disabled={!node.available}
                  disabledReason={availableReason}
                  onClick={() => onRun(node, 'remote_snapshot')}
                />
                {localHolders.map((holder) => (
                  <IconButton
                    key={holder.agentId}
                    icon={HardDriveUpload}
                    label={`Create snapshot of ${name} from the local copy on ${holder.agentName}`}
                    tooltip={`Create snapshot from the local copy on ${holder.agentName}`}
                    aria-haspopup="dialog"
                    onClick={() => onSnapshot(node, holder.agentId, holder.agentName)}
                  />
                ))}
              </>
            )}
          </ToolbarGroup>
          {!node.deletion ? (
            <>
              <ToolbarSeparator />
              <ToolbarGroup label={MANAGEMENT_GROUP}>
                <IconButton
                  icon={Pencil}
                  label={`Edit details of ${name}`}
                  tooltip="Edit details"
                  aria-haspopup="dialog"
                  onClick={() => onEditDetails(node)}
                />
                <IconButton
                  icon={Tags}
                  label={`Tags of ${name}`}
                  tooltip="Manage tags"
                  aria-haspopup="dialog"
                  onClick={() => onEditTags(node)}
                />
                <IconButton
                  icon={CopyPlus}
                  label={`Clone ${name} into a new VM`}
                  tooltip="Clone VM"
                  aria-haspopup="dialog"
                  disabled={!node.available}
                  disabledReason={availableReason}
                  onClick={() => onClone(node)}
                />
                <IconButton
                  icon={FolderOpen}
                  label={`View the archive contents of ${name}`}
                  tooltip="View contents"
                  aria-haspopup="dialog"
                  disabled={!node.available}
                  disabledReason={availableReason}
                  onClick={() => onViewContents(node)}
                />
              </ToolbarGroup>
            </>
          ) : null}
          {showDelete ? (
            <>
              <ToolbarSeparator />
              <ToolbarGroup label={LIFECYCLE_GROUP}>
                <IconButton
                  icon={ArrowUpToLine}
                  label={`Promote ${name} to master`}
                  tooltip="Promote to master"
                  aria-haspopup="dialog"
                  danger
                  onClick={() => onPromote(node)}
                />
                <IconButton
                  icon={Trash2}
                  label={`Delete ${name}`}
                  tooltip="Delete snapshot"
                  aria-haspopup="dialog"
                  danger
                  disabled={!node.deletable.eligible}
                  disabledReason={deleteReason}
                  onClick={() => onDelete(node)}
                />
              </ToolbarGroup>
            </>
          ) : null}
          <ToolbarSpacer />
          <InfoPopover
            icon={Info}
            label={`Information about ${name}`}
            tooltip="Version information"
            tooltipPlacement="start"
            title={title}
            wide
          >
            {() => (
              <VersionInfo
                node={node}
                parentLabel={parentLabel}
                childCount={children.length}
                isVirtualBox={isVirtualBox}
                linked={source !== null && lineage === node.id}
                restrictions={restrictions}
              />
            )}
          </InfoPopover>
        </Toolbar>
      </div>
      {children.length > 0 && expanded ? (
        <ul role="group" className="version-children">
          {children.map((child) => (
            <VersionItem
              key={child.node.id}
              entry={child}
              vm={vm}
              nameOf={nameOf}
              labelOf={labelOf}
              restoreOptions={restoreOptions}
              onRestore={onRestore}
              onSnapshot={onSnapshot}
              onRun={onRun}
              onDelete={onDelete}
              onRetryDelete={onRetryDelete}
              virtualbox={virtualbox}
              onImport={onImport}
              onEditDetails={onEditDetails}
              onEditTags={onEditTags}
              onPromote={onPromote}
              onClone={onClone}
              onViewContents={onViewContents}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Everything known about one version, on demand: all that the card used to show, and the archive's own facts. Only
 * what the version tree already carries; nothing here asks the API for more.
 */
function VersionInfo({
  node,
  parentLabel,
  childCount,
  isVirtualBox,
  linked,
  restrictions,
}: {
  node: VersionNode;
  parentLabel: string | null;
  childCount: number;
  isVirtualBox: boolean;
  linked: boolean;
  restrictions: [string, string][];
}) {
  return (
    <>
      <h4 className="info-section">Version</h4>
      <dl className="info-facts">
        {node.title ? (
          <>
            <dt>Label</dt>
            <dd>{versionLabel(node)}</dd>
          </>
        ) : null}
        <dt>Kind</dt>
        <dd>{node.kind === 'master' ? 'Master' : 'Snapshot'}</dd>
        <dt>Identifier</dt>
        <dd>
          <code className="vm-identity info-copyable">{node.id}</code>
        </dd>
        <dt>Created</dt>
        <dd>{formatTime(node.createdAt)}</dd>
        {node.promotedAt ? (
          <>
            <dt>Promoted</dt>
            <dd>{formatTime(node.promotedAt)}, from a snapshot</dd>
          </>
        ) : null}
        <dt>Parent</dt>
        <dd>
          {node.parentVersionId ? (
            <>
              {parentLabel ? `${parentLabel} ` : null}
              <span className="vm-identity" title={node.parentVersionId}>
                {shortId(node.parentVersionId)}
              </span>
            </>
          ) : (
            <span className="vm-identity">None (root)</span>
          )}
        </dd>
        <dt>Children</dt>
        <dd>{childCount === 0 ? 'None' : childCount === 1 ? 'One' : `${childCount} branches`}</dd>
        {node.createdByAgentName ? (
          <>
            <dt>From</dt>
            <dd>{node.createdByAgentName}</dd>
          </>
        ) : null}
        {node.createdByDisplayName ? (
          <>
            <dt>By</dt>
            <dd>{node.createdByDisplayName}</dd>
          </>
        ) : null}
        {node.tags.length > 0 ? (
          <>
            <dt>Tags</dt>
            <dd>{node.tags.map((tag) => `#${tag.name}`).join(' ')}</dd>
          </>
        ) : null}
      </dl>
      {node.description ? (
        <>
          <h4 className="info-section">Description</h4>
          {/* Plain text, never markup: React escapes it, and CSS keeps its line breaks. */}
          <p className="mb-0 version-description">{node.description}</p>
        </>
      ) : null}
      <h4 className="info-section">Archive</h4>
      <dl className="info-facts">
        <dt>Size</dt>
        <dd>{formatBytes(node.archiveSizeBytes)}</dd>
        {node.manifest ? (
          <>
            <dt>Files</dt>
            <dd>{node.manifest.fileCount}</dd>
            <dt>Uncompressed</dt>
            <dd>{formatBytes(node.manifest.totalUncompressedBytes)}</dd>
          </>
        ) : null}
        <dt>Repository</dt>
        <dd>
          {node.repositoryName}
          {node.available ? '' : ' (disabled)'}
        </dd>
        <dt>SHA-256</dt>
        <dd>
          <code className="info-copyable">{node.archiveSha256}</code>
        </dd>
        {node.manifest ? (
          <>
            <dt>Manifest</dt>
            <dd>
              <code className="info-copyable">{node.manifest.sha256}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {isVirtualBox ? (
        <p className="info-note mt-1 mb-0">
          An OVA exported by VirtualBox. It can be imported into VirtualBox as a new machine;
          nothing already there is replaced.
          {linked ? ' The linked machine comes from this version.' : ''}
        </p>
      ) : null}
      <h4 className="info-section">Verification</h4>
      <p className="mb-1">{verificationText(node)}.</p>
      {node.manifest && node.available && !node.deletion ? (
        <p className="info-note mb-0">
          This is what the agent checked when it published the archive. It does not say that the
          archive, or any local copy, has been verified since.
        </p>
      ) : null}
      <h4 className="info-section">Copies on agents</h4>
      {node.holders.length > 0 ? (
        <ul className="info-list">
          {node.holders.map((holder) => (
            <li key={`${holder.agentId}/${holder.workspaceId ?? 'local'}`}>{holderText(holder)}</li>
          ))}
        </ul>
      ) : (
        <p className="mb-0">No agent holds a copy derived from this version.</p>
      )}
      {node.deletion ? (
        <>
          <h4 className="info-section">Deletion</h4>
          <dl className="info-facts">
            <dt>Requested</dt>
            <dd>{formatTime(node.deletion.requestedAt)}</dd>
            <dt>Attempts</dt>
            <dd>{node.deletion.attempts}</dd>
            {node.deletion.error ? (
              <>
                <dt>Last error</dt>
                <dd>
                  <span className="vm-identity">{node.deletion.error.code}</span>:{' '}
                  {node.deletion.error.message}
                </dd>
              </>
            ) : null}
          </dl>
        </>
      ) : null}
      {restrictions.length > 0 ? (
        <>
          <h4 className="info-section">Unavailable now</h4>
          <dl className="info-facts">
            {restrictions.map(([action, reason]) => (
              <Fragment key={action}>
                <dt>{action}</dt>
                <dd>{reason}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
    </>
  );
}

function WorkspaceCard({
  workspace,
  vmName,
  onSnapshotStarted,
  onChange,
}: {
  workspace: RemoteSession;
  vmName: string;
  onSnapshotStarted: (operation: RegistrationOperation) => void;
  onChange: () => void;
}) {
  const [confirm, setConfirm] = useState<'preserve' | 'discard' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [launchRequest] = useState(newRequestId);
  const [preserveRequest] = useState(newRequestId);
  const ready = workspace.state === 'ready';

  const relaunch = async () => {
    setBusy(true);
    setError(null);
    try {
      await launchWorkspace(workspace.id, launchRequest);
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card mb-2">
      <div className="card-body py-2 small">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <strong>{workspace.agentName}</strong>
          <span
            className={`badge ${ready ? 'text-bg-success' : workspace.state === 'preparing' || workspace.state === 'discarding' ? 'text-bg-info' : 'text-bg-secondary'}`}
          >
            {WORKSPACE_STATE_TEXT[workspace.state]}
          </span>
          {workspace.mayHaveChanges && ready ? (
            <span className="badge text-bg-warning">May have unpreserved changes</span>
          ) : null}
          {!workspace.agentOnline ? (
            <span className="badge text-bg-light border">Offline</span>
          ) : null}
        </div>
        <div className="mt-1">
          A working copy of{' '}
          <span className="vm-identity">{shortId(workspace.sourceVersionId)}</span>
          {workspace.baseVersionId !== workspace.sourceVersionId ? (
            <>
              , first restored from{' '}
              <span className="vm-identity">{shortId(workspace.baseVersionId)}</span>
            </>
          ) : null}
          . Created {formatTime(workspace.createdAt)}. It is separate from the persistent local
          copy.
        </div>
        {workspace.error ? <div className="text-danger mt-1">{workspace.error.message}</div> : null}
        <FormError error={error} />
        {ready ? (
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy || !workspace.agentOnline}
              onClick={() => void relaunch()}
            >
              Launch again
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!workspace.agentOnline}
              onClick={() => setConfirm('preserve')}
            >
              Preserve as snapshot…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={() => setConfirm('discard')}
            >
              Discard…
            </button>
          </div>
        ) : null}
        {ready ? (
          <p className="text-body-secondary mt-2 mb-0">
            Stop a running session from the Run section first: a running VM cannot be preserved or
            discarded.
          </p>
        ) : null}
      </div>
      {confirm === 'preserve' ? (
        <ConfirmDialog
          title="Preserve as a new snapshot"
          action="Create snapshot"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const operation = await preserveWorkspace(workspace.id, preserveRequest);
            setConfirm(null);
            onSnapshotStarted(operation);
            onChange();
          }}
        >
          The agent archives this working copy as a new, immutable snapshot whose parent is{' '}
          <span className="vm-identity">{shortId(workspace.sourceVersionId)}</span>, verifies it in
          the repository, and only then records it. No existing version is changed. The VM must not
          be running.
        </ConfirmDialog>
      ) : null}
      {confirm === 'discard' ? (
        <ConfirmDialog
          title="Discard this working copy"
          action="Discard"
          danger
          confirmName={workspace.mayHaveChanges ? vmName : undefined}
          onClose={() => setConfirm(null)}
          onConfirm={async (typed) => {
            await discardWorkspace(workspace.id, typed);
            setConfirm(null);
            onChange();
          }}
        >
          The agent deletes this working copy from its computer.{' '}
          {workspace.mayHaveChanges
            ? 'It may hold changes that are not in any snapshot, and they will be lost.'
            : 'Everything in it is already in a snapshot.'}{' '}
          Versions, and the persistent local copy, are not affected.
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

/**
 * A VM's version history. Running a version is done in the run panel: these buttons only choose the
 * version and mode there (`onRun`), or, where there is no run panel, open it over the page.
 */
export function VmVersionHistory(props: VersionHistoryProps) {
  return props.vm.emulatorType === 'virtualbox' ? (
    <VirtualBoxVersionHistory {...props} />
  ) : (
    <VersionHistory {...props} virtualbox={null} />
  );
}

interface VersionHistoryProps {
  vm: VmIdentity;
  /** Draws the section's heading, with this identifier, in the history's own header. */
  headingId?: string | undefined;
  /** The VM's title, which names what an import creates. */
  title?: string | undefined;
  onRun?: ((preselect: Omit<RunPreselection, 'token'>) => void) | undefined;
}

function VirtualBoxVersionHistory(props: VersionHistoryProps) {
  return (
    <WithVirtualBoxManagement vm={props.vm}>
      {(management) => <VersionHistory {...props} virtualbox={management.data} />}
    </WithVirtualBoxManagement>
  );
}

/** What every version history is, said once, in the page's Info panel. */
function VersionHistoryInfo() {
  return (
    <>
      <p className="mb-2">
        Every version is a full, immutable archive; a snapshot records the version it was made from,
        so history can branch. Running a version in a remote mode never changes it, nor any local
        copy.
      </p>
      <p className="info-note mb-0">
        Each version’s Info button gives its identity, archive, verification, the copies agents hold
        and why an action is unavailable now.
      </p>
    </>
  );
}

/** The history's compact header: its name and count, then what applies to the whole history, and Info. */
function VersionHistoryHeader({
  headingId,
  count,
  children,
}: {
  headingId?: string | undefined;
  count?: number | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="version-history-header">
      {headingId ? (
        <h2 id={headingId} className="version-history-title">
          <History size={ICON_SIZE + 2} aria-hidden="true" />
          Version History
        </h2>
      ) : null}
      {count !== undefined ? (
        <span className="toolbar-text">{count === 1 ? 'One version' : `${count} versions`}</span>
      ) : null}
      <Toolbar label="Version history actions" className="version-history-actions">
        {children}
        <InfoPopover
          icon={Info}
          label="About the version history"
          tooltip="About the version history"
          tooltipPlacement="start"
          title="About the version history"
          wide
        >
          <VersionHistoryInfo />
        </InfoPopover>
      </Toolbar>
    </div>
  );
}

function VersionHistory({
  vm,
  title,
  onRun,
  virtualbox,
  headingId,
}: VersionHistoryProps & { virtualbox: VirtualBoxManagementResponse | null }) {
  const { emulatorType, vmName } = vm;
  const identity = { emulatorType, vmName };
  const loadTree = useCallback(
    (signal: AbortSignal) => fetchVersionTree({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadWorkspaces = useCallback(
    (signal: AbortSignal) => fetchWorkspaces({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadOptions = useCallback(
    (signal: AbortSignal) => fetchRestoreOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const [fastPoll, setFastPoll] = useState(false);
  const interval = fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  // A VirtualBox VM is never restored and has no working copies (decision 0045), so those are read once and again
  // after a change made here. Its versions change only by a snapshot or a deletion, which this page follows.
  const isVirtualBox = emulatorType === 'virtualbox';
  const tree = usePolledData(
    loadTree,
    isVirtualBox && !fastPoll ? VIRTUALBOX_IDLE_POLL_MS : interval,
  );
  const workspaces = usePolledData(loadWorkspaces, isVirtualBox ? null : interval);
  const options = usePolledData(loadOptions, isVirtualBox ? null : interval);
  const loadRemasters = useCallback(
    (signal: AbortSignal) => fetchRemasters({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  // Read once, and again after a change made here: a remaster in progress is followed on its own.
  const remasters = usePolledData(loadRemasters, null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [running, setRunning] = useState<RunPreselection | null>(null);
  const [snapshotting, setSnapshotting] = useState<SnapshotRequest | null>(null);
  const [snapshotOperation, setSnapshotOperation] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VersionNode | null>(null);
  const [importing, setImporting] = useState<VersionNode | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [editing, setEditing] = useState<VersionNode | null>(null);
  const [tagging, setTagging] = useState<VersionNode | null>(null);
  const [promoting, setPromoting] = useState<VersionNode | null>(null);
  const [remastering, setRemastering] = useState(false);
  const [cloning, setCloning] = useState<VersionNode | null>(null);
  const [viewing, setViewing] = useState<VersionNode | null>(null);
  const [clones, setClones] = useState<string[]>([]);
  const [startedRemaster, setStartedRemaster] = useState<string | null>(null);
  const runToken = useRef(0);

  // Only Milestone 7's manual working copies are managed here. Remote sessions belong to the run panel.
  const manual = (workspaces.data?.workspaces ?? []).filter((item) => item.purpose === 'manual');
  const busy =
    snapshotOperation !== null ||
    manual.some((item) => item.state === 'preparing' || item.state === 'discarding') ||
    (tree.data?.versions.some((version) => version.deletion !== null) ?? false);
  if (busy !== fastPoll) setFastPoll(busy);

  const refresh = () => {
    tree.refresh();
    workspaces.refresh();
    options.refresh();
    remasters.refresh();
  };

  if (tree.error && !tree.data) {
    return (
      <div className="version-history">
        <VersionHistoryHeader headingId={headingId} />
        <p className="small text-body-secondary">The version history is not available right now.</p>
      </div>
    );
  }
  if (!tree.data) {
    return (
      <div className="version-history">
        <VersionHistoryHeader headingId={headingId} />
        <p className="small text-body-secondary">Loading the version history…</p>
      </div>
    );
  }

  const built = buildVersionTree(tree.data.versions);
  // Snapshot labels are minutes, so two can be the same. Their controls must still be told apart.
  const labelCounts = new Map<string, number>();
  for (const version of tree.data.versions) {
    const label = versionLabel(version);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const nameOf = (node: VersionNode) => {
    const label = versionLabel(node);
    return (labelCounts.get(label) ?? 0) > 1 ? `${label} (${node.id.slice(-8)})` : label;
  };
  const activeManual = manual.filter((item) =>
    ['preparing', 'ready', 'running', 'discarding'].includes(item.state),
  );
  const recentEnded = manual.filter((item) => ['failed', 'lost'].includes(item.state)).slice(0, 3);

  const run = (node: VersionNode, mode: ExecutionMode) => {
    if (onRun) {
      onRun({ versionId: node.id, mode });
      return;
    }
    runToken.current += 1;
    setRunning({ versionId: node.id, mode, token: runToken.current });
  };
  const retryDelete = async (node: VersionNode) => {
    setRetryError(null);
    try {
      await retrySnapshotDeletion(identity, node.id);
      refresh();
    } catch (failure) {
      setRetryError(failure);
    }
  };
  // A remaster in progress, or the one started from this page, is followed until it ends.
  const remasterList = remasters.data?.remasters ?? [];
  const followed = remasterList
    .filter(
      (item) =>
        item.state === 'exporting' || item.state === 'cleaning' || item.id === startedRemaster,
    )
    .map((item) => item.id);
  if (startedRemaster && !followed.includes(startedRemaster)) followed.unshift(startedRemaster);
  const remasterActive = remasterList.some((item) => item.state === 'exporting');
  // Copies that could become the new master: the agents' persistent copies, or the linked VirtualBox machine.
  const remasterChoices: RemasterSourceChoice[] = [];
  if (isVirtualBox) {
    if (virtualbox?.source) {
      remasterChoices.push({
        agentId: virtualbox.source.agentId,
        agentName: virtualbox.source.agentName,
      });
    }
  } else {
    for (const version of tree.data.versions) {
      for (const holder of version.holders) {
        if (holder.kind === 'local' && !remasterChoices.some((c) => c.agentId === holder.agentId)) {
          remasterChoices.push({ agentId: holder.agentId, agentName: holder.agentName });
        }
      }
    }
  }
  const labelOf = (id: string) => {
    const found = tree.data?.versions.find((version) => version.id === id);
    return found ? versionLabel(found) : null;
  };
  const parentOf = (node: VersionNode) =>
    node.parentVersionId ? labelOf(node.parentVersionId) : null;

  const drawable = built.ok && built.root !== null;
  return (
    <div className="version-history">
      <VersionHistoryHeader headingId={headingId} count={built.ok ? built.count : undefined}>
        {drawable && remasterChoices.length > 0 ? (
          <IconButton
            icon={RefreshCw}
            label="Remaster from local copy"
            tooltipPlacement="start"
            aria-haspopup="dialog"
            danger
            disabled={remasterActive}
            disabledReason={remasterActive ? 'A remaster is already in progress.' : null}
            onClick={() => setRemastering(true)}
          />
        ) : null}
      </VersionHistoryHeader>
      {snapshotOperation ? (
        <SnapshotProgress
          key={snapshotOperation}
          operationId={snapshotOperation}
          onFinished={refresh}
        />
      ) : null}
      {followed.map((remasterId) => (
        <RemasterProgress key={remasterId} remasterId={remasterId} onChanged={refresh} />
      ))}
      {clones.map((operationId) => (
        <CloneProgress key={operationId} operationId={operationId} onFinished={refresh} />
      ))}
      <FormError error={retryError} />
      {!built.ok ? (
        <div className="alert alert-danger small" role="alert">
          The version history is inconsistent ({built.problem.replaceAll('_', ' ')}), so it is not
          drawn. No version has been changed.
        </div>
      ) : built.root === null ? (
        <p className="small">This VM has no versions yet.</p>
      ) : (
        <>
          <ul role="tree" aria-label={`Versions of ${vmName}`} className="version-tree">
            <VersionItem
              entry={built.root}
              vm={identity}
              nameOf={nameOf}
              labelOf={labelOf}
              restoreOptions={options.data}
              onRestore={setRestoring}
              onSnapshot={(node, agentId, agentName) =>
                setSnapshotting({
                  agentId,
                  agentName,
                  parentVersionId: node.id,
                  parentLabel: versionLabel(node),
                  machineName: virtualbox?.source?.displayName,
                })
              }
              onRun={run}
              onDelete={setDeleting}
              onRetryDelete={(node) => void retryDelete(node)}
              virtualbox={virtualbox}
              onImport={setImporting}
              onEditDetails={setEditing}
              onEditTags={setTagging}
              onPromote={setPromoting}
              onClone={setCloning}
              onViewContents={setViewing}
            />
          </ul>
        </>
      )}

      {activeManual.length > 0 || recentEnded.length > 0 ? (
        <>
          <h3 className="h6 mt-4">Manual working copies</h3>
          <p className="small text-body-secondary">
            Working copies prepared by hand before remote sessions finished on their own. They are
            kept exactly as they were, and only change when you preserve or discard them here.
          </p>
          <ul className="list-unstyled">
            {[...activeManual, ...recentEnded].map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                vmName={vmName}
                onSnapshotStarted={(operation) => setSnapshotOperation(operation.id)}
                onChange={refresh}
              />
            ))}
          </ul>
        </>
      ) : null}

      {restoring && options.data ? (
        <RestoreDialog
          vm={identity}
          options={options.data}
          initialVersionId={restoring}
          onClose={() => setRestoring(null)}
          onStarted={() => {
            setRestoring(null);
            refresh();
          }}
          onSnapshotFirst={(request) => {
            setRestoring(null);
            setSnapshotting(request);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteSnapshotDialog
          vm={identity}
          node={deleting}
          parentLabel={parentOf(deleting)}
          onClose={() => setDeleting(null)}
          onStarted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      ) : null}
      {running ? (
        <VmLaunchDialog
          vm={identity}
          title={vmName}
          preselect={running}
          onClose={() => setRunning(null)}
        />
      ) : null}
      {importing && virtualbox ? (
        <ImportIntoVirtualBoxDialog
          vm={identity}
          title={title ?? vmName}
          version={{ id: importing.id, label: versionLabel(importing) }}
          agents={virtualbox.agents}
          source={virtualbox.source}
          onClose={() => setImporting(null)}
          onStarted={() => {
            setImporting(null);
            notifyVirtualBoxChanged(identity);
          }}
        />
      ) : null}
      {tagging ? (
        <TagEditorDialog
          title={tagging.kind === 'master' ? 'Master tags' : 'Snapshot tags'}
          subject={nameOf(tagging)}
          target={{ kind: 'version', vm: identity, versionId: tagging.id }}
          value={tagging.tags}
          onChange={(tags) => {
            const id = tagging.id;
            setTagging((current) => (current?.id === id ? { ...current, tags } : current));
            if (tree.data) {
              tree.setData({
                ...tree.data,
                versions: tree.data.versions.map((node) =>
                  node.id === id ? { ...node, tags } : node,
                ),
              });
            }
          }}
          onClose={() => setTagging(null)}
        />
      ) : null}
      {editing ? (
        <EditVersionDetailsDialog
          vm={identity}
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            tree.refresh();
          }}
        />
      ) : null}
      {promoting ? (
        <PromoteSnapshotDialog
          vm={identity}
          node={promoting}
          onClose={() => setPromoting(null)}
          onStarted={(operation) => {
            setPromoting(null);
            setStartedRemaster(operation.id);
            refresh();
          }}
        />
      ) : null}
      {remastering ? (
        <LocalRemasterDialog
          vm={identity}
          choices={remasterChoices}
          onClose={() => setRemastering(false)}
          onStarted={(operation) => {
            setRemastering(false);
            setStartedRemaster(operation.id);
            refresh();
            if (isVirtualBox) notifyVirtualBoxChanged(identity);
          }}
        />
      ) : null}
      {viewing ? (
        <ArchiveExplorerDialog vm={identity} node={viewing} onClose={() => setViewing(null)} />
      ) : null}
      {cloning ? (
        <CloneVmDialog
          vm={identity}
          title={title ?? vmName}
          node={cloning}
          onClose={() => setCloning(null)}
          onStarted={(operation) => {
            setCloning(null);
            setClones((current) => [operation.id, ...current]);
            refresh();
          }}
        />
      ) : null}
      {snapshotting ? (
        <CreateSnapshotDialog
          vm={identity}
          request={snapshotting}
          onClose={() => setSnapshotting(null)}
          onStarted={(operation: RegistrationOperation) => {
            setSnapshotting(null);
            setSnapshotOperation(operation.id);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** The version history as a section of the VM's administration page. */
export function VmVersionsSection({
  vm,
  title,
  onRun,
}: {
  vm: VmIdentity;
  title?: string | undefined;
  onRun?: ((preselect: Omit<RunPreselection, 'token'>) => void) | undefined;
}) {
  return (
    <section className="card" aria-labelledby="vm-versions-heading">
      <div className="card-body">
        <VmVersionHistory vm={vm} title={title} onRun={onRun} headingId="vm-versions-heading" />
      </div>
    </section>
  );
}
