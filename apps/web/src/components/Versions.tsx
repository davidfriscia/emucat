import {
  buildVersionTree,
  type ExecutionMode,
  type RegistrationOperation,
  type RemoteSession,
  type RestoreOptionsResponse,
  type VersionNode,
  type VersionTreeEntry,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useRef, useState } from 'react';
import {
  discardWorkspace,
  fetchRestoreOptions,
  fetchVersionTree,
  fetchWorkspaces,
  launchWorkspace,
  preserveWorkspace,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { ConfirmDialog } from './Dialogs';
import { VmLaunchDialog, WORKSPACE_STATE_TEXT, type RunPreselection } from './Execution';
import { RestoreDialog } from './Restore';
import {
  CreateSnapshotDialog,
  shortId,
  SnapshotProgress,
  versionLabel,
  type SnapshotRequest,
} from './Snapshots';
import { FormError } from './States';

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
  restoreOptions,
  onRestore,
  onSnapshot,
  onRun,
}: {
  entry: VersionTreeEntry;
  vm: VmIdentity;
  restoreOptions: RestoreOptionsResponse | null;
  onRestore: (versionId: string) => void;
  onSnapshot: (node: VersionNode, agentId: string, agentName: string) => void;
  onRun: (node: VersionNode, mode: ExecutionMode) => void;
}) {
  const { node, depth, children } = entry;
  const [expanded, setExpanded] = useState(true);
  const headingId = `version-${node.id}`;
  const canRestore = node.available && (restoreOptions?.agents.some((a) => a.online) ?? false);
  const localHolders = node.holders.filter((holder) => holder.kind === 'local');
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
                aria-label={
                  expanded ? `Collapse ${versionLabel(node)}` : `Expand ${versionLabel(node)}`
                }
                onClick={() => setExpanded((value) => !value)}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              </button>
            ) : null}
            <h4 id={headingId} className="h6 mb-0">
              {versionLabel(node)}
            </h4>
            <span
              className={`badge ${node.kind === 'master' ? 'text-bg-primary' : 'text-bg-secondary'}`}
            >
              {node.kind === 'master' ? 'Root' : 'Snapshot'}
            </span>
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
          </dl>
          <p className="small text-body-secondary mb-1">{verificationText(node)}</p>
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
          <div className="d-flex flex-wrap gap-2 mt-1">
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
              aria-label={`Run ${versionLabel(node)} in Remote Volatile`}
              onClick={() => onRun(node, 'remote_volatile')}
            >
              Run volatile…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!node.available}
              aria-label={`Run ${versionLabel(node)} in Remote Snapshot`}
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
          </div>
        </div>
      </div>
      {children.length > 0 && expanded ? (
        <ul role="group" className="version-children">
          {children.map((child) => (
            <VersionItem
              key={child.node.id}
              entry={child}
              vm={vm}
              restoreOptions={restoreOptions}
              onRestore={onRestore}
              onSnapshot={onSnapshot}
              onRun={onRun}
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
export function VmVersionHistory({
  vm,
  onRun,
}: {
  vm: VmIdentity;
  onRun?: ((preselect: Omit<RunPreselection, 'token'>) => void) | undefined;
}) {
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
  const tree = usePolledData(loadTree, interval);
  const workspaces = usePolledData(loadWorkspaces, interval);
  const options = usePolledData(loadOptions, interval);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [running, setRunning] = useState<RunPreselection | null>(null);
  const [snapshotting, setSnapshotting] = useState<SnapshotRequest | null>(null);
  const [snapshotOperation, setSnapshotOperation] = useState<string | null>(null);
  const runToken = useRef(0);

  // Only Milestone 7's manual working copies are managed here. Remote sessions belong to the run panel.
  const manual = (workspaces.data?.workspaces ?? []).filter((item) => item.purpose === 'manual');
  const busy =
    snapshotOperation !== null ||
    manual.some((item) => item.state === 'preparing' || item.state === 'discarding');
  if (busy !== fastPoll) setFastPoll(busy);

  const refresh = () => {
    tree.refresh();
    workspaces.refresh();
    options.refresh();
  };

  if (tree.error && !tree.data) {
    return (
      <p className="small text-body-secondary">The version history is not available right now.</p>
    );
  }
  if (!tree.data) return <p className="small text-body-secondary">Loading the version history…</p>;

  const built = buildVersionTree(tree.data.versions);
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

  return (
    <div className="version-history">
      {snapshotOperation ? (
        <SnapshotProgress
          key={snapshotOperation}
          operationId={snapshotOperation}
          onFinished={refresh}
        />
      ) : null}
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
          <ul role="tree" aria-label={`Versions of ${vmName}`} className="version-tree">
            <VersionItem
              entry={built.root}
              vm={identity}
              restoreOptions={options.data}
              onRestore={setRestoring}
              onSnapshot={(node, agentId, agentName) =>
                setSnapshotting({
                  agentId,
                  agentName,
                  parentVersionId: node.id,
                  parentLabel: versionLabel(node),
                })
              }
              onRun={run}
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
      {running ? (
        <VmLaunchDialog
          vm={identity}
          title={vmName}
          preselect={running}
          onClose={() => setRunning(null)}
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
  onRun,
}: {
  vm: VmIdentity;
  onRun?: ((preselect: Omit<RunPreselection, 'token'>) => void) | undefined;
}) {
  return (
    <section className="card" aria-labelledby="vm-versions-heading">
      <div className="card-body">
        <h2 id="vm-versions-heading" className="h6 card-title">
          Version history
        </h2>
        <VmVersionHistory vm={vm} onRun={onRun} />
      </div>
    </section>
  );
}
