import type { ArchiveSummary, ArchiveView, VersionNode, VmIdentity } from '@emucat/contracts';
import { Info, ShieldAlert, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { fetchArchiveSummary } from '../api';
import { LocalArchiveClient, type WorkerLike } from '../archive-local/client';
import { DEFAULT_LOCAL_LIMITS, type LocalArchiveLimits } from '../archive-local/limits';
import { useAsync } from '../useAsync';
import { formatBytes, formatTime } from './Agents';
import { FilePanel } from './archive-explorer/FilePanel';
import { PreviewProblem } from './archive-explorer/problems';
import type { FileSource } from './archive-explorer/source';
import { ArchiveTree, type TreeRequest } from './archive-explorer/Tree';
import { useModalDialog } from './Gallery';
import { versionLabel } from './Snapshots';
import { LoadingState } from './States';
import { IconButton, ToolbarGroup } from './ui/IconButton';
import { InfoPopover } from './ui/Popover';

/**
 * Archive Explorer (decisions 0055, 0056 and 0058): what a version's archive holds, and any one file in it, read by
 * the server over its own repository connection. Nothing is downloaded whole, extracted to disk or changed; no agent
 * is involved. A tree of directories, listed as they are opened, sits beside the selected file's preview.
 *
 * An archive inside the version's archive can be opened in the tree: that one file is downloaded through the
 * existing single-file API, and the browser's archive worker reads it, and archives inside it, in memory. The worker
 * belongs to this dialog and is terminated, with everything it holds, when the dialog closes.
 *
 * These are files of archives (configuration, NVRAM, ROMs, documents, disk images as files). What is inside a virtual
 * disk (its guest filesystem) is not explored.
 */

const VIEW_TEXT: Record<ArchiveView, string> = {
  logical: 'VM files',
  physical: 'Stored entries',
};

const SPLIT_KEY = 'emucat.archiveExplorer.split';
const MIN_TREE = 200;

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value >= MIN_TREE ? value : 320;
  } catch {
    return 320;
  }
}

function Summary({ summary }: { summary: ArchiveSummary }) {
  const { archive, manifest, physical } = summary;
  return (
    <>
      <dl className="small settings-facts mb-2">
        <dt>Archive</dt>
        <dd className="text-break">
          <code>{archive.fileName}</code> ({archive.format.toUpperCase()}) in{' '}
          {archive.repositoryName}
        </dd>
        <dt>Size</dt>
        <dd>{formatBytes(archive.sizeBytes)}</dd>
        <dt>SHA-256</dt>
        <dd className="text-break">
          <code>{archive.sha256}</code>
        </dd>
        {manifest ? (
          <>
            <dt>VM files</dt>
            <dd>
              {manifest.fileCount} files in {manifest.directoryCount} directories,{' '}
              {formatBytes(manifest.totalUncompressedBytes)}
            </dd>
            <dt>Manifest</dt>
            <dd>
              Version {manifest.manifestVersion}
              {manifest.matchesRegistration === true
                ? ', the one verified when this version was registered'
                : manifest.matchesRegistration === false
                  ? ', which differs from the one verified at registration'
                  : ''}
            </dd>
          </>
        ) : null}
        <dt>Stored entries</dt>
        <dd>
          {physical.entryCount} ({formatBytes(physical.compressedBytes)} stored,{' '}
          {formatBytes(physical.uncompressedBytes)} uncompressed)
        </dd>
      </dl>
      <p className="small text-body-secondary mb-2">
        This is a complete archive: restoring this version needs nothing else, and it is never a
        difference from another version.
      </p>
      <p className="small text-body-secondary mb-2">
        Read through the server’s own repository connection. Nothing is downloaded whole, extracted
        or changed. <strong>VM files</strong> lists the VM’s files from the manifest;{' '}
        <strong>Stored entries</strong> lists what the archive file holds.
      </p>
      <p className="small text-body-secondary mb-0">
        Opening an archive inside it downloads that one file, whole, through the server’s
        single-file download (verified as it arrives), and reads it in this browser, in memory. Up
        to {formatBytes(DEFAULT_LOCAL_LIMITS.maxArchiveBytes)} an archive and{' '}
        {DEFAULT_LOCAL_LIMITS.maxDepth} levels deep; {formatBytes(DEFAULT_LOCAL_LIMITS.cacheBytes)}{' '}
        of opened archives are kept, the least recently used released first.
      </p>
    </>
  );
}

function Warnings({ summary }: { summary: ArchiveSummary }) {
  return (
    <>
      {summary.warnings.map((warning) => (
        <div key={warning} className="alert alert-warning small mb-2" role="status">
          {warning}
        </div>
      ))}
      {summary.manifest?.matchesRegistration === false ? (
        <div className="alert alert-danger small mb-2" role="alert">
          The manifest in the archive is not the one that was verified. Verify this version before
          relying on it. Files are not checked against this manifest’s SHA-256 values.
        </div>
      ) : null}
    </>
  );
}

function Placeholder({ view }: { view: ArchiveView }) {
  return (
    <div className="archive-placeholder">
      <p className="small mb-2">Select a file to see its preview.</p>
      <p className="small text-body-secondary mb-2">
        {view === 'logical'
          ? 'The VM’s files as this version restores them, from the archive’s manifest.'
          : 'The entries stored in the archive file itself.'}{' '}
        Text, images, PDF and Markdown files can be previewed; any file can be shown as bytes, and
        downloaded individually up to the server’s limit. ZIP, TAR, OVA and GZIP archives inside it
        can be expanded and browsed in your browser.
      </p>
      <p className="small text-body-secondary mb-0">
        What is inside a virtual disk image (its guest filesystem) is not explored.
      </p>
    </div>
  );
}

export function ArchiveExplorerDialog({
  vm,
  node,
  onClose,
  localLimits,
  createWorker,
}: {
  vm: VmIdentity;
  node: VersionNode;
  onClose: () => void;
  /** For tests: other browser-local limits, and a worker that runs in the same thread. */
  localLimits?: LocalArchiveLimits;
  createWorker?: () => WorkerLike;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, close, onClose);
  const ids = useId();
  const [view, setView] = useState<ArchiveView>(
    vm.emulatorType === 'virtualbox' ? 'physical' : 'logical',
  );
  const [visited, setVisited] = useState<Set<ArchiveView>>(() => new Set([view]));
  const [selected, setSelected] = useState<{ view: ArchiveView; source: FileSource } | null>(null);
  const [request, setRequest] = useState<{ view: ArchiveView; request: TreeRequest } | null>(null);
  const [pane, setPane] = useState<'tree' | 'file'>('tree');
  const [split, setSplit] = useState(readSplit);
  const body = useRef<HTMLDivElement>(null);
  // One archive worker for this dialog, started on first use and terminated with the dialog.
  const client = useMemo(
    () => new LocalArchiveClient(localLimits ?? DEFAULT_LOCAL_LIMITS, createWorker),
    [localLimits, createWorker],
  );
  useEffect(() => () => client.dispose(), [client]);
  // The nested archives the shown file is in: the cache keeps them while it is shown.
  const pinned = useRef<string[]>([]);
  useEffect(() => {
    pinned.current = selected?.source.container?.archiveIds ?? [];
  }, [selected]);

  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) => fetchArchiveSummary({ emulatorType, vmName }, node.id, signal),
    [emulatorType, vmName, node.id],
  );
  const { state } = useAsync(load);
  const summary = state.status === 'success' ? state.data : null;
  const views = summary?.views ?? [];
  const shownView = views.includes(view) ? view : (views[0] ?? view);
  const label = node.title ? `${versionLabel(node)} — ${node.title}` : versionLabel(node);

  const chooseView = (next: ArchiveView) => {
    setView(next);
    setVisited((current) => new Set([...current, next]));
  };
  const select = (source: FileSource) => {
    setSelected({ view: shownView, source });
    setPane('file');
  };
  const nonce = useRef(0);
  const ask = (key: string, open: boolean) => {
    if (!selected) return;
    nonce.current += 1;
    setRequest({ view: selected.view, request: { key, open, nonce: nonce.current } });
    if (selected.view !== shownView) chooseView(selected.view);
    setPane('tree');
  };

  const saveSplit = (value: number) => {
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(value)));
    } catch {
      // Kept for this visit only.
    }
  };
  const clampSplit = (value: number) => {
    // Not laid out (zero wide): only the minimum applies.
    const width = body.current?.clientWidth || Number.POSITIVE_INFINITY;
    return Math.max(MIN_TREE, Math.min(value, width * 0.7));
  };
  const onSplitterDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = split;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    let latest = initial;
    const move = (moved: globalThis.PointerEvent) => {
      latest = clampSplit(initial + moved.clientX - start);
      setSplit(latest);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      saveSplit(latest);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const onSplitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = clampSplit(split + delta);
    setSplit(next);
    saveSplit(next);
  };

  const kindWord = node.kind === 'master' ? 'Master' : 'Snapshot';
  const identity = [
    kindWord,
    label === kindWord ? null : label,
    summary ? summary.archive.format.toUpperCase() : null,
    summary ? formatBytes(summary.archive.sizeBytes) : null,
    summary ? summary.archive.repositoryName : null,
  ].filter(Boolean);

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card archive-explorer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
      >
        <div className="card-body d-flex flex-column archive-explorer-body">
          <header className="archive-explorer-header">
            <div className="min-w-0 flex-grow-1">
              <h2 id={`${ids}-title`} className="h6 card-title mb-0">
                Archive Explorer
              </h2>
              <p
                className="archive-identity text-break"
                title={summary ? `Created ${formatTime(summary.version.createdAt)}` : undefined}
              >
                {identity.join(' · ')}
              </p>
            </div>
            {summary?.manifest?.matchesRegistration === false ? (
              <ShieldAlert
                size={18}
                className="text-danger flex-shrink-0"
                aria-label="Manifest differs from the verified one"
                role="img"
              />
            ) : null}
            <InfoPopover
              icon={Info}
              label="Archive information"
              title="This archive"
              disabled={!summary}
              wide
            >
              {() =>
                summary ? (
                  <>
                    <dl className="info-facts">
                      <dt>Version</dt>
                      <dd>
                        {node.kind === 'master' ? 'Master' : 'Snapshot'}: {label}
                      </dd>
                      <dt>Created</dt>
                      <dd>{formatTime(summary.version.createdAt)}</dd>
                    </dl>
                    <Summary summary={summary} />
                  </>
                ) : null
              }
            </InfoPopover>
            <IconButton
              ref={close}
              icon={X}
              label="Close"
              onClick={onClose}
              tooltipPlacement="start"
            />
          </header>
          {state.status === 'loading' ? <LoadingState label="Reading the archive" /> : null}
          {state.status === 'error' ? <PreviewProblem error={state.error} /> : null}
          {summary ? (
            <>
              <Warnings summary={summary} />
              {views.length > 1 ? (
                <div className="archive-explorer-toolbar">
                  <ToolbarGroup label="View">
                    {views.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`icon-button icon-button-text ${option === shownView ? 'icon-button-pressed' : ''}`}
                        aria-pressed={option === shownView}
                        onClick={() => chooseView(option)}
                      >
                        {VIEW_TEXT[option]}
                      </button>
                    ))}
                  </ToolbarGroup>
                </div>
              ) : null}
              <div
                ref={body}
                className="archive-split"
                data-pane={pane}
                style={{ ['--archive-tree-width' as string]: `${split}px` }}
              >
                <div className="archive-pane archive-tree-pane">
                  {views.map((option) =>
                    visited.has(option) || option === shownView ? (
                      <div key={option} hidden={option !== shownView}>
                        <ArchiveTree
                          vm={vm}
                          versionId={node.id}
                          view={option}
                          rootLabel={VIEW_TEXT[option]}
                          client={client}
                          pinned={pinned}
                          selectedKey={selected?.view === option ? selected.source.key : null}
                          onSelect={select}
                          request={request?.view === option ? request.request : null}
                        />
                      </div>
                    ) : null,
                  )}
                </div>
                <div
                  className="archive-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the file list"
                  aria-valuenow={Math.round(split)}
                  aria-valuemin={MIN_TREE}
                  tabIndex={0}
                  onPointerDown={onSplitterDown}
                  onKeyDown={onSplitterKey}
                />
                <div className="archive-pane archive-file-pane">
                  {selected ? (
                    <FilePanel
                      key={`${selected.view}\0${selected.source.key}`}
                      source={selected.source}
                      onBack={() => setPane('tree')}
                      onReveal={(key) => ask(key, false)}
                      onBrowse={(key) => ask(key, true)}
                    />
                  ) : (
                    <Placeholder view={shownView} />
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
