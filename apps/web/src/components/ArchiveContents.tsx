import {
  ARCHIVE_INSPECTION_ERROR_TEXT,
  type ArchiveEntry,
  type ArchiveListingResponse,
  type ArchiveSummary,
  type ArchiveView,
  type VersionNode,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, fetchArchiveEntries, fetchArchiveSummary } from '../api';
import { useAsync } from '../useAsync';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
import { versionLabel } from './Snapshots';
import { LoadingState } from './States';

/**
 * View Archive Contents (decision 0055): what a version's archive holds, read by the server over its own repository
 * connection without downloading, extracting or changing anything. Directories are listed one at a time, as they are
 * opened, so a large archive never arrives in one piece.
 */

const PAGE_SIZE = 200;

const VIEW_TEXT: Record<ArchiveView, string> = {
  logical: 'VM files',
  physical: 'Stored entries',
};

const METHOD_TEXT: Record<NonNullable<ArchiveEntry['method']>, string> = {
  stored: 'stored',
  deflated: 'deflated',
  other: 'other',
};

function problemText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return ARCHIVE_INSPECTION_ERROR_TEXT[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : 'The archive could not be listed.';
}

function Problem({ error }: { error: unknown }) {
  return (
    <div className="alert alert-warning small mb-0" role="alert">
      {problemText(error)}
    </div>
  );
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
      {summary.warnings.map((warning) => (
        <div key={warning} className="alert alert-warning small mb-2" role="status">
          {warning}
        </div>
      ))}
      {manifest?.matchesRegistration === false ? (
        <div className="alert alert-danger small mb-2" role="alert">
          The manifest in the archive is not the one that was verified. Verify this version before
          relying on it.
        </div>
      ) : null}
    </>
  );
}

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const segments = path === '' ? [] : path.split('/');
  return (
    <nav aria-label="Archive path" className="small mb-2">
      <ol className="breadcrumb mb-0">
        <li className="breadcrumb-item">
          {segments.length === 0 ? (
            <span aria-current="location">Top</span>
          ) : (
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onOpen('')}>
              Top
            </button>
          )}
        </li>
        {segments.map((segment, index) => {
          const target = segments.slice(0, index + 1).join('/');
          const last = index === segments.length - 1;
          return (
            <li key={target} className="breadcrumb-item">
              {last ? (
                <span aria-current="location">{segment}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-link btn-sm p-0"
                  onClick={() => onOpen(target)}
                >
                  {segment}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Listing({
  vm,
  versionId,
  view,
}: {
  vm: VmIdentity;
  versionId: string;
  view: ArchiveView;
}) {
  const ids = useId();
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | null>(null);

  const { emulatorType, vmName } = vm;
  const load = useCallback(
    async (offset: number, signal?: AbortSignal) =>
      fetchArchiveEntries(
        { emulatorType, vmName },
        versionId,
        { view, path, q: query ?? undefined, offset, limit: PAGE_SIZE },
        signal,
      ),
    [emulatorType, vmName, versionId, view, path, query],
  );

  const first = useCallback((signal: AbortSignal) => load(0, signal), [load]);
  const { state } = useAsync(first);
  // Further pages belong to the listing they continue, and are dropped when it changes.
  const [extra, setExtra] = useState<{
    load: unknown;
    pages: ArchiveListingResponse[];
    loading: boolean;
    error: unknown;
  } | null>(null);
  const current = extra?.load === load ? extra : null;
  const pages = state.status === 'success' ? [state.data, ...(current?.pages ?? [])] : [];
  const loading = state.status === 'loading' || (current?.loading ?? false);
  const error = state.status === 'error' ? state.error : (current?.error ?? null);

  const more = async () => {
    const last = pages.at(-1);
    if (!last || last.nextOffset === null) return;
    const earlier = current?.pages ?? [];
    setExtra({ load, pages: earlier, loading: true, error: null });
    try {
      const page = await load(last.nextOffset);
      setExtra({ load, pages: [...earlier, page], loading: false, error: null });
    } catch (failure) {
      setExtra({ load, pages: earlier, loading: false, error: failure });
    }
  };

  const open = (next: string) => {
    setQuery(null);
    setSearch('');
    setPath(next);
  };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery(search.trim() === '' ? null : search.trim());
  };

  const entries = pages.flatMap((page) => page.entries);
  const total = pages[0]?.total ?? 0;
  const nextOffset = pages.at(-1)?.nextOffset ?? null;
  const physical = view === 'physical';
  return (
    <div>
      <form className="d-flex gap-2 mb-2" role="search" onSubmit={submitSearch}>
        <label htmlFor={`${ids}-search`} className="visually-hidden">
          Search paths
        </label>
        <input
          id={`${ids}-search`}
          className="form-control form-control-sm"
          type="search"
          placeholder="Search all paths"
          maxLength={200}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-outline-secondary theme-button">
          Search
        </button>
        {query !== null ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button"
            onClick={() => open(path)}
          >
            Clear
          </button>
        ) : null}
      </form>
      {query === null ? (
        <Breadcrumbs path={path} onOpen={open} />
      ) : (
        <p className="small mb-2" role="status">
          {total} {total === 1 ? 'path matches' : 'paths match'} “{query}”.
        </p>
      )}
      {error ? <Problem error={error} /> : null}
      {!error ? (
        <div className="table-responsive archive-listing">
          <table className="table table-sm small mb-1">
            <caption className="visually-hidden">
              {VIEW_TEXT[view]} in {query === null ? path || 'the top directory' : 'the search'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="text-end">
                  Size
                </th>
                {physical ? (
                  <>
                    <th scope="col" className="text-end d-none d-md-table-cell">
                      Stored
                    </th>
                    <th scope="col" className="d-none d-md-table-cell">
                      Method
                    </th>
                    <th scope="col" className="d-none d-lg-table-cell">
                      Modified
                    </th>
                  </>
                ) : (
                  <th scope="col" className="d-none d-md-table-cell">
                    SHA-256
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path}>
                  <td className="text-break">
                    {entry.type === 'directory' ? (
                      <button
                        type="button"
                        className="btn btn-link btn-sm p-0 text-start"
                        aria-label={`Open directory ${entry.path}`}
                        onClick={() => open(entry.path)}
                      >
                        {query === null ? entry.name : entry.path}/
                      </button>
                    ) : (
                      <span>{query === null ? entry.name : entry.path}</span>
                    )}
                    {entry.type === 'directory' && entry.childCount !== null ? (
                      <span className="text-body-secondary"> ({entry.childCount})</span>
                    ) : null}
                  </td>
                  <td className="text-end text-nowrap">
                    {entry.sizeBytes === null ? '' : formatBytes(entry.sizeBytes)}
                  </td>
                  {physical ? (
                    <>
                      <td className="text-end text-nowrap d-none d-md-table-cell">
                        {entry.compressedSizeBytes === null
                          ? ''
                          : formatBytes(entry.compressedSizeBytes)}
                      </td>
                      <td className="d-none d-md-table-cell">
                        {entry.method ? METHOD_TEXT[entry.method] : ''}
                      </td>
                      <td className="d-none d-lg-table-cell text-nowrap">
                        {entry.modifiedAt ?? ''}
                      </td>
                    </>
                  ) : (
                    <td className="d-none d-md-table-cell">
                      {entry.sha256 ? (
                        <code title={entry.sha256}>{entry.sha256.slice(0, 12)}…</code>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && entries.length === 0 ? (
            <p className="small text-body-secondary">Nothing here.</p>
          ) : null}
        </div>
      ) : null}
      {loading ? <LoadingState label="Reading the archive" /> : null}
      {!loading && !error && nextOffset !== null ? (
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary theme-button"
          onClick={() => void more()}
        >
          Show more ({entries.length} of {total})
        </button>
      ) : null}
    </div>
  );
}

export function ArchiveContentsDialog({
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

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
      >
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start gap-2">
            <h2 id={`${ids}-title`} className="h5 card-title">
              Archive contents
            </h2>
            <button
              ref={close}
              type="button"
              className="btn-close"
              aria-label="Close"
              onClick={onClose}
            />
          </div>
          <p className="small mb-2">
            {node.kind === 'master' ? 'Master' : 'Snapshot'}: {label}
            {summary ? ` · created ${formatTime(summary.version.createdAt)}` : null}
          </p>
          {state.status === 'loading' ? <LoadingState label="Reading the archive" /> : null}
          {state.status === 'error' ? <Problem error={state.error} /> : null}
          {summary ? (
            <>
              <Summary summary={summary} />
              {views.length > 1 ? (
                <div className="btn-group btn-group-sm mb-2" role="group" aria-label="View">
                  {views.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`btn ${option === shownView ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
                      aria-pressed={option === shownView}
                      onClick={() => setView(option)}
                    >
                      {VIEW_TEXT[option]}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="small text-body-secondary mb-2">
                {shownView === 'logical'
                  ? 'The VM’s files as this version restores them, from the archive’s manifest.'
                  : 'The entries stored in the archive file itself.'}{' '}
                Read through the server’s own repository connection. Nothing is downloaded,
                extracted or changed.
              </p>
              <Listing key={shownView} vm={vm} versionId={node.id} view={shownView} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
