import type {
  ArchiveEntry,
  ArchiveSummary,
  ArchiveView,
  VersionNode,
  VmIdentity,
} from '@emucat/contracts';
import { useCallback, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fetchArchiveSummary } from '../api';
import { useAsync } from '../useAsync';
import { formatBytes, formatTime } from './Agents';
import { FilePanel } from './archive-explorer/FilePanel';
import { PreviewProblem } from './archive-explorer/problems';
import { ArchiveTree } from './archive-explorer/Tree';
import { useModalDialog } from './Gallery';
import { versionLabel } from './Snapshots';
import { LoadingState } from './States';

/**
 * Archive Explorer (decisions 0055 and 0056): what a version's archive holds, and any one file in it, read by the
 * server over its own repository connection. Nothing is downloaded whole, extracted to disk or changed; no agent is
 * involved. A tree of directories, listed as they are opened, sits beside the selected file's details and preview.
 *
 * These are the files stored in the archive itself (configuration, NVRAM, ROMs, documents, disk images as files).
 * What is inside a virtual disk (its guest filesystem) is not explored.
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

function Placeholder({ summary, view }: { summary: ArchiveSummary; view: ArchiveView }) {
  return (
    <div className="archive-placeholder">
      <p className="small mb-2">Select a file to see its details and a preview.</p>
      <p className="small text-body-secondary mb-2">
        {view === 'logical'
          ? 'The VM’s files as this version restores them, from the archive’s manifest.'
          : 'The entries stored in the archive file itself.'}{' '}
        Text, images, PDF and Markdown files can be previewed; any file can be shown as bytes, and
        downloaded individually up to the server’s limit.
      </p>
      <p className="small text-body-secondary mb-0">
        Only the files of the archive itself are shown. What is inside a virtual disk image is not
        explored.
      </p>
      <details className="mt-3">
        <summary className="small">Archive details</summary>
        <div className="mt-2">
          <Summary summary={summary} />
        </div>
      </details>
    </div>
  );
}

export function ArchiveExplorerDialog({
  vm,
  node,
  onClose,
}: {
  vm: VmIdentity;
  node: VersionNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, close, onClose);
  const ids = useId();
  const [view, setView] = useState<ArchiveView>(
    vm.emulatorType === 'virtualbox' ? 'physical' : 'logical',
  );
  const [visited, setVisited] = useState<Set<ArchiveView>>(() => new Set([view]));
  const [selected, setSelected] = useState<{ view: ArchiveView; entry: ArchiveEntry } | null>(null);
  const [pane, setPane] = useState<'tree' | 'file'>('tree');
  const [split, setSplit] = useState(readSplit);
  const body = useRef<HTMLDivElement>(null);

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
  const select = (entry: ArchiveEntry) => {
    setSelected({ view: shownView, entry });
    setPane('file');
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
          <div className="d-flex justify-content-between align-items-start gap-2">
            <div className="min-w-0">
              <h2 id={`${ids}-title`} className="h5 card-title mb-1">
                Archive Explorer
              </h2>
              <p className="small mb-2 text-break">
                {node.kind === 'master' ? 'Master' : 'Snapshot'}: {label}
                {summary ? ` · created ${formatTime(summary.version.createdAt)}` : null}
                {summary
                  ? ` · ${summary.archive.format.toUpperCase()}, ${formatBytes(summary.archive.sizeBytes)} in ${summary.archive.repositoryName}`
                  : null}
              </p>
            </div>
            <button
              ref={close}
              type="button"
              className="btn-close"
              aria-label="Close"
              onClick={onClose}
            />
          </div>
          {state.status === 'loading' ? <LoadingState label="Reading the archive" /> : null}
          {state.status === 'error' ? <PreviewProblem error={state.error} /> : null}
          {summary ? (
            <>
              <Warnings summary={summary} />
              <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                {views.length > 1 ? (
                  <div className="btn-group btn-group-sm" role="group" aria-label="View">
                    {views.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`btn ${option === shownView ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
                        aria-pressed={option === shownView}
                        onClick={() => chooseView(option)}
                      >
                        {VIEW_TEXT[option]}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="small text-body-secondary d-none d-md-inline">
                  Read through the server’s own repository connection. Nothing is downloaded whole,
                  extracted or changed.
                </span>
              </div>
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
                          selectedPath={selected?.view === option ? selected.entry.path : null}
                          onSelect={select}
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
                      key={`${selected.view}\0${selected.entry.path}`}
                      vm={vm}
                      versionId={node.id}
                      view={selected.view}
                      entry={selected.entry}
                      onBack={() => setPane('tree')}
                    />
                  ) : (
                    <Placeholder summary={summary} view={shownView} />
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
