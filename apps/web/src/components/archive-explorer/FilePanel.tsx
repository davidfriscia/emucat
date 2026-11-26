import type {
  ArchiveEntry,
  ArchiveEntryDetails,
  ArchivePreviewKind,
  ArchivePreviewMode,
  ArchiveView,
  VmIdentity,
} from '@emucat/contracts';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  downloadArchiveFile,
  fetchArchiveEntry,
  fetchArchivePreview,
  type ArchiveFileRef,
  type ArchivePreviewBytes,
} from '../../api';
import { useAsync } from '../../useAsync';
import { formatBytes } from '../Agents';
import { LoadingState } from '../States';
import { PreviewProblem, problemText } from './problems';
import { HexViewer, ImageViewer, MarkdownViewer, TextViewer } from './viewers';

/** PDF.js is large, so it is only loaded when a PDF is opened. */
const PdfViewer = lazy(() => import('./PdfViewer'));

const MODE_TEXT: Record<ArchivePreviewMode, string> = {
  text: 'Text',
  rendered: 'Rendered',
  image: 'Image',
  pdf: 'PDF',
  hex: 'Hex',
};

const KIND_TEXT: Record<ArchiveEntryDetails['detected']['kind'], string> = {
  text: 'Text',
  markdown: 'Markdown',
  image: 'Image',
  pdf: 'PDF document',
  binary: 'Binary data',
};

const previewKind = (mode: ArchivePreviewMode): ArchivePreviewKind | null =>
  mode === 'rendered' || mode === 'text'
    ? 'text'
    : mode === 'image'
      ? 'image'
      : mode === 'pdf'
        ? 'pdf'
        : null;

function Facts({ details }: { details: ArchiveEntryDetails }) {
  const { entry } = details;
  const sha = details.manifestSha256 ?? entry.sha256;
  return (
    <dl className="small settings-facts archive-facts mb-2">
      <dt>Path</dt>
      <dd className="text-break">
        <code>{entry.path}</code>
      </dd>
      <dt>Size</dt>
      <dd>
        {formatBytes(entry.sizeBytes ?? 0)}
        {entry.compressedSizeBytes !== null && details.compression === 'deflated'
          ? `, ${formatBytes(entry.compressedSizeBytes)} stored`
          : ''}
      </dd>
      <dt>Stored as</dt>
      <dd>{details.compression === 'deflated' ? 'Deflated' : 'Stored, uncompressed'}</dd>
      {entry.modifiedAt ? (
        <>
          <dt>Modified</dt>
          <dd>{entry.modifiedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')}</dd>
        </>
      ) : null}
      <dt>Type</dt>
      <dd>
        {KIND_TEXT[details.detected.kind]}
        {details.detected.format !== details.detected.kind
          ? ` (${details.detected.format.toUpperCase()})`
          : ''}
        , from its contents
      </dd>
      {details.crc32 ? (
        <>
          <dt>CRC-32</dt>
          <dd>
            <code>{details.crc32}</code>
          </dd>
        </>
      ) : null}
      {sha ? (
        <>
          <dt>SHA-256</dt>
          <dd className="text-break">
            <code>{sha}</code> <span className="text-body-secondary">(from the manifest)</span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function DownloadButton({
  vm,
  versionId,
  file,
  details,
}: {
  vm: VmIdentity;
  versionId: string;
  file: ArchiveFileRef;
  details: ArchiveEntryDetails;
}) {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'running'; received: number }
    | { status: 'error'; error: unknown }
    | { status: 'done' }
  >({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  if (!details.download.allowed) {
    return (
      <p className="small text-body-secondary mb-2">
        Files larger than {formatBytes(details.download.maxBytes)} cannot be downloaded one at a
        time
        {details.download.maxBytes === 0
          ? ' (single-file downloads are turned off on this server)'
          : ''}
        . Restore the version to get it.
      </p>
    );
  }
  const start = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ status: 'running', received: 0 });
    try {
      const blob = await downloadArchiveFile(vm, versionId, file, {
        signal: current.signal,
        onProgress: (received) => setState({ status: 'running', received }),
      });
      if (current.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = details.entry.name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState({ status: 'done' });
    } catch (error) {
      if (!current.signal.aborted) setState({ status: 'error', error });
    }
  };
  const size = details.entry.sizeBytes ?? 0;
  return (
    <div className="mb-2">
      <div className="d-flex gap-2 align-items-center flex-wrap">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={state.status === 'running'}
          onClick={() => void start()}
        >
          Download file
        </button>
        {state.status === 'running' ? (
          <>
            <span className="small" role="status">
              {formatBytes(state.received)} of {formatBytes(size)}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-link"
              onClick={() => {
                controller.current?.abort();
                setState({ status: 'idle' });
              }}
            >
              Cancel
            </button>
          </>
        ) : null}
        {state.status === 'done' ? (
          <span className="small text-success-emphasis" role="status">
            Downloaded and verified.
          </span>
        ) : null}
        <span className="small text-body-secondary">
          Up to {formatBytes(details.download.maxBytes)} a file.
        </span>
      </div>
      {state.status === 'error' ? (
        <div className="alert alert-warning small mt-2 mb-0" role="alert">
          {problemText(state.error, 'The download failed.')}
        </div>
      ) : null}
    </div>
  );
}

function PreviewBody({
  details,
  mode,
  cached,
}: {
  details: ArchiveEntryDetails;
  mode: Exclude<ArchivePreviewMode, 'hex'>;
  cached: (kind: ArchivePreviewKind) => Promise<ArchivePreviewBytes>;
}) {
  const kind = previewKind(mode) as ArchivePreviewKind;
  const load = useCallback(() => cached(kind), [cached, kind]);
  const { state } = useAsync(load);
  if (state.status === 'loading') return <LoadingState label="Reading the file" />;
  if (state.status === 'error') return <PreviewProblem error={state.error} />;
  const preview: ArchivePreviewBytes = state.data;
  const { path } = details.entry;
  if (mode === 'image') return <ImageViewer preview={preview} path={path} />;
  if (mode === 'pdf') {
    return (
      <Suspense fallback={<LoadingState label="Loading the PDF viewer" />}>
        <PdfViewer preview={preview} path={path} />
      </Suspense>
    );
  }
  if (mode === 'rendered') return <MarkdownViewer preview={preview} path={path} />;
  return (
    <TextViewer
      preview={preview}
      path={path}
      language={details.detected.language}
      detected={details.detected.encoding}
    />
  );
}

/**
 * The right panel: one file's details and its preview. Mounted once per selected file, so that choosing another
 * file aborts what this one still had in flight and nothing it receives late can replace the newer file.
 */
export function FilePanel({
  vm,
  versionId,
  view,
  entry,
  onBack,
}: {
  vm: VmIdentity;
  versionId: string;
  view: ArchiveView;
  entry: ArchiveEntry;
  onBack: () => void;
}) {
  const { emulatorType, vmName } = vm;
  const [file] = useState<ArchiveFileRef>(() => ({ view, path: entry.path }));
  const load = useCallback(
    (signal: AbortSignal) => fetchArchiveEntry({ emulatorType, vmName }, versionId, file, signal),
    [emulatorType, vmName, versionId, file],
  );
  const { state } = useAsync(load);
  const [chosen, setChosen] = useState<ArchivePreviewMode | null>(null);
  const details = state.status === 'success' ? state.data : null;
  // One request per kind of preview for this file, shared by its modes (Text and Rendered read the same bytes), and
  // aborted with the panel.
  const previews = useRef(new Map<ArchivePreviewKind, Promise<ArchivePreviewBytes>>());
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const requests = previews.current;
    return () => {
      lifetime.current?.abort();
      lifetime.current = null;
      requests.clear();
    };
  }, []);
  const cached = useCallback(
    (kind: ArchivePreviewKind) => {
      let request = previews.current.get(kind);
      if (!request) {
        // Made on first use: a child's effect runs before this component's own.
        lifetime.current ??= new AbortController();
        request = fetchArchivePreview({ emulatorType, vmName }, versionId, file, kind, {
          signal: lifetime.current.signal,
        });
        // A failure is not kept: trying the mode again asks again.
        request.catch(() => previews.current.delete(kind));
        previews.current.set(kind, request);
      }
      return request;
    },
    [emulatorType, vmName, versionId, file],
  );
  const mode = chosen && details?.modes.includes(chosen) ? chosen : (details?.modes[0] ?? null);

  return (
    <section className="archive-file-panel" aria-label={`File ${entry.name}`}>
      <button type="button" className="btn btn-sm btn-link px-0 d-md-none" onClick={onBack}>
        ← Back to files
      </button>
      <h3 className="h6 text-break mb-1">{entry.name}</h3>
      {state.status === 'loading' ? <LoadingState label="Reading the file’s details" /> : null}
      {state.status === 'error' ? <PreviewProblem error={state.error} /> : null}
      {details && mode ? (
        <>
          <Facts details={details} />
          <DownloadButton vm={vm} versionId={versionId} file={file} details={details} />
          {Object.values(details.unavailable).map((reason) => (
            <p key={reason} className="small text-body-secondary mb-1">
              {reason} Only the hexadecimal view is available.
            </p>
          ))}
          {details.modes.length > 1 ? (
            <div className="btn-group btn-group-sm mb-2" role="group" aria-label="Preview mode">
              {details.modes.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`btn ${option === mode ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
                  aria-pressed={option === mode}
                  onClick={() => setChosen(option)}
                >
                  {MODE_TEXT[option]}
                </button>
              ))}
            </div>
          ) : null}
          {details.detected.kind === 'binary' ? (
            <p className="small text-body-secondary mb-1">
              No preview is available for this kind of file: its bytes are shown instead.
            </p>
          ) : null}
          {mode === 'hex' ? (
            <HexViewer vm={vm} versionId={versionId} file={file} details={details} />
          ) : (
            <PreviewBody key={mode} details={details} mode={mode} cached={cached} />
          )}
        </>
      ) : null}
    </section>
  );
}
