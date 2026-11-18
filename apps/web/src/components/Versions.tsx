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
import { useCallback, useRef, useState } from 'react';
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

/** One version, with its children nested under it. A list inside a list is what keeps branches visible. */
function VersionItem({
  entry,
  vm,
  nameOf,
  restoreOptions,
  onRestore,
  onSnapshot,
  onRun,
  onDelete,
  onRetryDelete,
  virtualbox,
  onImport,
  onEditDetails,
  onPromote,
}: {
  entry: VersionTreeEntry;
  onEditDetails: (node: VersionNode) => void;
  onPromote: (node: VersionNode) => void;
  vm: VmIdentity;
  /** For a VirtualBox VM, its machine and agents; `null` while unknown or for another emulator. */
  virtualbox: VirtualBoxManagementResponse | null;
  onImport: (node: VersionNode) => void;
  /** The version's name for assistive technology: unique in the tree, even when labels repeat. */
  nameOf: (node: VersionNode) => string;
  restoreOptions: RestoreOptionsResponse | null;
  onRestore: (versionId: string) => void;
  onSnapshot: (node: VersionNode, agentId: string, agentName: string) => void;
  onRun: (node: VersionNode, mode: ExecutionMode) => void;
  onDelete: (node: VersionNode) => void;
  onRetryDelete: (node: VersionNode) => void;
}) {
  const { node, depth, children } = entry;
  const deleteReason = deletionReasonText(node);
  const deleteHelpId = `version-delete-help-${node.id}`;
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
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-labelledby={headingId}
      aria-expanded={children.length > 0 ? expanded : undefined}
      className="version-node"
    >
      <div className="version-card card mb-2">
        <div className="card-body py-2">
          <div className="d-flex flex-wrap align-items-center gap-2">
            {children.length > 0 ? (
              <button
                type="button"
                className="btn btn-sm btn-link p-0 version-toggle"
                aria-label={expanded ? `Collapse ${nameOf(node)}` : `Expand ${nameOf(node)}`}
                onClick={() => setExpanded((value) => !value)}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              </button>
            ) : null}
            <h4 id={headingId} className="h6 mb-0 version-title">
              {node.title ?? versionLabel(node)}
            </h4>
            {node.title ? (
              <span className="small text-body-secondary">{versionLabel(node)}</span>
            ) : null}
            <span
              className={`badge ${node.kind === 'master' ? 'text-bg-primary' : 'text-bg-secondary'}`}
            >
              {node.kind === 'master' ? 'Master' : 'Snapshot'}
            </span>
            {node.promotedAt ? (
              <span className="badge text-bg-light border">Promoted from a snapshot</span>
            ) : null}
            {node.deletion ? <span className="badge text-bg-danger">Being deleted</span> : null}
            <span className="small text-body-secondary vm-identity" title={node.id}>
              {shortId(node.id)}
            </span>
            {children.length > 1 ? (
              <span className="badge text-bg-light border">{children.length} branches</span>
            ) : null}
          </div>
          <dl className="small version-facts mb-1">
            <div>
              <dt>Created</dt>
              <dd>{formatTime(node.createdAt)}</dd>
            </div>
            <div>
              <dt>Parent</dt>
              <dd className="vm-identity">
                {node.parentVersionId ? shortId(node.parentVersionId) : 'None (root)'}
              </dd>
            </div>
            <div>
              <dt>Archive</dt>
              <dd>{formatBytes(node.archiveSizeBytes)}</dd>
            </div>
            {node.createdByAgentName ? (
              <div>
                <dt>From</dt>
                <dd>{node.createdByAgentName}</dd>
              </div>
            ) : null}
            {node.promotedAt ? (
              <div>
                <dt>Promoted</dt>
                <dd>{formatTime(node.promotedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {node.description ? (
            <details className="small mb-1 version-description">
              <summary>Description</summary>
              {/* Plain text, never markup: React escapes it, and CSS keeps its line breaks. */}
              <p className="mb-0 mt-1" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {node.description}
              </p>
            </details>
          ) : null}
          <p className="small text-body-secondary mb-1">{verificationText(node)}</p>
          {node.deletion ? (
            <div className="small mb-1" role="status">
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
                      aria-label={`Retry deleting ${nameOf(node)} now`}
                      onClick={() => onRetryDelete(node)}
                    >
                      Retry now
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {node.holders.length > 0 ? (
            <ul className="list-inline small mb-1">
              {node.holders.map((holder) => (
                <li
                  key={`${holder.agentId}/${holder.workspaceId ?? 'local'}`}
                  className="list-inline-item badge text-bg-light border"
                >
                  {holderText(holder)}
                </li>
              ))}
            </ul>
          ) : null}
          {isVirtualBox ? (
            <>
              <p className="small text-body-secondary mb-1">
                An OVA exported by VirtualBox. It can be imported into VirtualBox as a new machine;
                nothing already there is replaced.
                {source && lineage === node.id
                  ? ' The linked machine comes from this version.'
                  : ''}
              </p>
              <div className="d-flex flex-wrap gap-2 mt-1">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  disabled={
                    !node.available || node.deletion !== null || !importer || virtualBoxBusy
                  }
                  aria-label={`Import ${nameOf(node)} into VirtualBox`}
                  aria-haspopup="dialog"
                  onClick={() => onImport(node)}
                >
                  Import into VirtualBox…
                </button>
                {snapshotParent && source ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary theme-button"
                    disabled={
                      !node.available ||
                      node.deletion !== null ||
                      virtualBoxBusy ||
                      source.state !== 'powered_off' ||
                      !source.agentOnline
                    }
                    aria-label={`Create snapshot of ${source.displayName} from ${nameOf(node)}`}
                    onClick={() => onSnapshot(node, source.agentId, source.agentName)}
                  >
                    Create snapshot…
                  </button>
                ) : null}
                {node.kind === 'snapshot' && !node.deletion ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    disabled={!node.deletable.eligible}
                    aria-label={`Delete ${nameOf(node)}`}
                    aria-describedby={deleteReason ? deleteHelpId : undefined}
                    aria-haspopup="dialog"
                    onClick={() => onDelete(node)}
                  >
                    Delete snapshot…
                  </button>
                ) : null}
              </div>
              {virtualbox && !importer ? (
                <p className="small text-body-secondary mt-1 mb-0">
                  No online agent can import into VirtualBox.
                </p>
              ) : null}
              {snapshotParent && source && source.state !== 'powered_off' ? (
                <p className="small text-body-secondary mt-1 mb-0">
                  Power the machine off to create a snapshot.
                </p>
              ) : null}
            </>
          ) : null}
          <div className={`d-flex flex-wrap gap-2 mt-1${isVirtualBox ? ' d-none' : ''}`}>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!canRestore}
              onClick={() => onRestore(node.id)}
            >
              Restore…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!node.available}
              aria-label={`Run ${nameOf(node)} in Remote Volatile`}
              onClick={() => onRun(node, 'remote_volatile')}
            >
              Run volatile…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!node.available}
              aria-label={`Run ${nameOf(node)} in Remote Snapshot`}
              onClick={() => onRun(node, 'remote_snapshot')}
            >
              Run and snapshot…
            </button>
            {localHolders.map((holder) => (
              <button
                key={holder.agentId}
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                onClick={() => onSnapshot(node, holder.agentId, holder.agentName)}
              >
                Create snapshot from {holder.agentName}…
              </button>
            ))}
            {node.kind === 'snapshot' && !node.deletion ? (
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={!node.deletable.eligible}
                aria-label={`Delete ${nameOf(node)}`}
                aria-describedby={deleteReason ? deleteHelpId : undefined}
                aria-haspopup="dialog"
                onClick={() => onDelete(node)}
              >
                Delete snapshot…
              </button>
            ) : null}
          </div>
          {node.kind === 'snapshot' && !node.deletion && deleteReason ? (
            <p id={deleteHelpId} className="small text-body-secondary mt-1 mb-0">
              Cannot be deleted now: {deleteReason}
            </p>
          ) : null}
          {!node.deletion ? (
            <div className="d-flex flex-wrap gap-2 mt-1">
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                aria-label={`Edit details of ${nameOf(node)}`}
                aria-haspopup="dialog"
                onClick={() => onEditDetails(node)}
              >
                Edit details…
              </button>
              {node.kind === 'snapshot' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  aria-label={`Promote ${nameOf(node)} to master`}
                  aria-haspopup="dialog"
                  onClick={() => onPromote(node)}
                >
                  Promote to master…
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {children.length > 0 && expanded ? (
        <ul role="group" className="version-children">
          {children.map((child) => (
            <VersionItem
              key={child.node.id}
              entry={child}
              vm={vm}
              nameOf={nameOf}
              restoreOptions={restoreOptions}
              onRestore={onRestore}
              onSnapshot={onSnapshot}
              onRun={onRun}
              onDelete={onDelete}
              onRetryDelete={onRetryDelete}
              virtualbox={virtualbox}
              onImport={onImport}
              onEditDetails={onEditDetails}
              onPromote={onPromote}
            />
          ))}
        </ul>
      ) : null}
    </li>
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

function VersionHistory({
  vm,
  title,
  onRun,
  virtualbox,
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
  const [promoting, setPromoting] = useState<VersionNode | null>(null);
  const [remastering, setRemastering] = useState(false);
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
      <p className="small text-body-secondary">The version history is not available right now.</p>
    );
  }
  if (!tree.data) return <p className="small text-body-secondary">Loading the version history…</p>;

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
  const parentOf = (node: VersionNode) => {
    const parent = tree.data?.versions.find((version) => version.id === node.parentVersionId);
    return parent ? versionLabel(parent) : null;
  };

  return (
    <div className="version-history">
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
          <p className="small text-body-secondary">
            {built.count === 1 ? 'One version' : `${built.count} versions`}. Every version is a
            full, immutable archive; a snapshot records the version it was made from, so history can
            branch. Running a version in a remote mode never changes it, nor any local copy.
          </p>
          {remasterChoices.length > 0 ? (
            <div className="mb-2">
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={remasterActive}
                aria-haspopup="dialog"
                onClick={() => setRemastering(true)}
              >
                Remaster from local copy…
              </button>
            </div>
          ) : null}
          <ul role="tree" aria-label={`Versions of ${vmName}`} className="version-tree">
            <VersionItem
              entry={built.root}
              vm={identity}
              nameOf={nameOf}
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
              onPromote={setPromoting}
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
        <h2 id="vm-versions-heading" className="h6 card-title">
          Version history
        </h2>
        <VmVersionHistory vm={vm} title={title} onRun={onRun} />
      </div>
    </section>
  );
}
