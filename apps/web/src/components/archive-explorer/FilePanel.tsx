import type {
  ArchiveEntryDetails,
  ArchivePreviewKind,
  ArchivePreviewMode,
} from '@emucat/contracts';
import {
  ArrowLeft,
  Binary,
  BookOpen,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FileType,
  FolderOpen,
  Image,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ArchivePreviewBytes } from '../../api';
import { useAsync } from '../../useAsync';
import { formatBytes } from '../Agents';
import { LoadingState } from '../States';
import {
  IconButton,
  IconToggleButton,
  Toolbar,
  ToolbarGroup,
  ToolbarSpacer,
} from '../ui/IconButton';
import { FileTypeIcon, fileIconKind } from '../ui/FileTypeIcon';
import { InfoPopover } from '../ui/Popover';
import { StatusItem, ViewerChromeContext } from './chrome';
import { PreviewProblem, problemText } from './problems';
import type { Crumb, FileSource } from './source';
import { HexViewer, ImageViewer, MarkdownViewer, TextViewer } from './viewers';

/** PDF.js is large, so it is only loaded when a PDF is opened. */
const PdfViewer = lazy(() => import('./PdfViewer'));

const MODES: Record<ArchivePreviewMode, { text: string; icon: LucideIcon; tooltip: string }> = {
  text: { text: 'Text', icon: FileText, tooltip: 'Text' },
  rendered: { text: 'Rendered', icon: BookOpen, tooltip: 'Rendered Markdown' },
  image: { text: 'Image', icon: Image, tooltip: 'Image' },
  pdf: { text: 'PDF', icon: FileType, tooltip: 'PDF document' },
  hex: { text: 'Hex', icon: Binary, tooltip: 'Hexadecimal bytes' },
};

const KIND_TEXT: Record<ArchiveEntryDetails['detected']['kind'], string> = {
  text: 'Text',
  markdown: 'Markdown',
  image: 'Image',
  pdf: 'PDF document',
  binary: 'Binary data',
};

const FORMAT_TEXT: Record<string, string> = {
  zip: 'ZIP',
  tar: 'TAR',
  ova: 'OVA (TAR)',
  gzip: 'GZIP',
  'tar.gz': 'TAR.GZ',
};

const previewKind = (mode: ArchivePreviewMode): Exclude<ArchivePreviewKind, 'hex'> | null =>
  mode === 'rendered' || mode === 'text'
    ? 'text'
    : mode === 'image'
      ? 'image'
      : mode === 'pdf'
        ? 'pdf'
        : null;

const timestamp = (value: string) => value.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="info-hash">
      <code>{value}</code>
      <IconButton
        icon={Copy}
        label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      />
    </span>
  );
}

/**
 * Everything known about the file, on demand. What each value rests on is said: declared by the archive that holds
 * it, verified by reading the file, or recorded in the EmuCat manifest (a trusted record of the outer archive only).
 */
function FileFacts({
  source,
  details,
  verified,
}: {
  source: FileSource;
  details: ArchiveEntryDetails | null;
  verified: ArchivePreviewBytes['integrity'] | null;
}) {
  const entry = details?.entry ?? source.listing;
  const sha = details ? (details.manifestSha256 ?? entry.sha256) : entry.sha256;
  const nested = source.origin === 'nested';
  return (
    <>
      <dl className="info-facts">
        <dt>Name</dt>
        <dd className="text-break">{entry.name}</dd>
        <dt>Location</dt>
        <dd className="text-break">
          <code>{source.displayPath}</code>
        </dd>
        <dt>Size</dt>
        <dd>
          {formatBytes(entry.sizeBytes ?? 0)} ({(entry.sizeBytes ?? 0).toLocaleString('en')} bytes)
        </dd>
        {details ? (
          <>
            <dt>Stored as</dt>
            <dd>
              {details.compression === 'deflated'
                ? `Deflated${entry.compressedSizeBytes !== null ? `, ${formatBytes(entry.compressedSizeBytes)} stored` : ''}`
                : 'Stored, uncompressed'}
            </dd>
            <dt>Type</dt>
            <dd>
              {KIND_TEXT[details.detected.kind]}
              {details.detected.format !== details.detected.kind
                ? ` (${details.detected.format.toUpperCase()})`
                : ''}
              , from its contents
              {details.detected.encoding ? `; ${details.detected.encoding.name}` : ''}
            </dd>
          </>
        ) : null}
        {entry.modifiedAt ? (
          <>
            <dt>Modified</dt>
            <dd>{timestamp(entry.modifiedAt)}</dd>
          </>
        ) : null}
      </dl>
      <h4 className="info-section">Integrity</h4>
      <dl className="info-facts">
        {details?.crc32 ? (
          <>
            <dt>CRC-32</dt>
            <dd>
              <CopyValue value={details.crc32} label="CRC-32" />
              <div className="info-note">
                Declared by {nested ? 'the nested archive' : 'the archive'}.
              </div>
            </dd>
          </>
        ) : null}
        {sha ? (
          <>
            <dt>SHA-256</dt>
            <dd>
              <CopyValue value={sha} label="SHA-256" />
              <div className="info-note">From the EmuCat manifest of this version.</div>
            </dd>
          </>
        ) : nested ? (
          <>
            <dt>SHA-256</dt>
            <dd className="info-note">
              Not recorded. The EmuCat manifest covers the files of the outer archive, not the files
              inside a nested one.
            </dd>
          </>
        ) : null}
        <dt>Checked</dt>
        <dd>
          {verified === 'verified'
            ? nested
              ? 'Read whole in this browser: it matched the CRC-32 its archive records. That detects damage; it is not proof of origin.'
              : 'Read whole by the server: it matched its recorded checksum.'
            : verified === 'complete'
              ? 'Read whole. Its archive format records no checksum.'
              : 'Not read whole yet. A partial preview is never checked.'}
        </dd>
      </dl>
      {source.container ? (
        <>
          <h4 className="info-section">Nested archive</h4>
          <dl className="info-facts">
            <dt>Inside</dt>
            <dd className="text-break">{source.container.chain.join(' › ')}</dd>
            <dt>Format</dt>
            <dd>
              {FORMAT_TEXT[source.container.format] ?? source.container.format}, level{' '}
              {source.container.depth}
            </dd>
            <dt>Read</dt>
            <dd>
              In this browser, from {formatBytes(source.container.payloadBytes)} held in memory. Its
              outermost archive was downloaded once, whole, through the server’s single-file
              download, which verified it.
            </dd>
          </dl>
        </>
      ) : null}
      {details ? (
        <>
          <h4 className="info-section">Previews and download</h4>
          <ul className="info-list">
            <li>
              {details.download.allowed
                ? `Can be downloaded (up to ${formatBytes(details.download.maxBytes)} a file).`
                : downloadRefusal(details)}
            </li>
            {Object.values(details.unavailable).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            <li>
              Text is previewed up to {formatBytes(details.limits.textBytes)}, images up to{' '}
              {formatBytes(details.limits.imageBytes)}, PDF up to{' '}
              {formatBytes(details.limits.pdfBytes)}.
            </li>
          </ul>
        </>
      ) : null}
    </>
  );
}

const downloadRefusal = (details: ArchiveEntryDetails) =>
  details.download.maxBytes === 0
    ? 'Single-file downloads are turned off on this server. Restore the version to get it.'
    : `Files larger than ${formatBytes(details.download.maxBytes)} cannot be downloaded one at a time. Restore the version to get it.`;

type DownloadState =
  | { status: 'idle' }
  | { status: 'running'; received: number }
  | { status: 'error'; error: unknown }
  | { status: 'done'; integrity: FileSource['integrityScope'] };

function useDownload(source: FileSource) {
  const [state, setState] = useState<DownloadState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const start = async (name: string) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ status: 'running', received: 0 });
    try {
      const blob = await source.download({
        signal: current.signal,
        onProgress: (received) => setState({ status: 'running', received }),
      });
      if (current.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = safeDownloadName(name);
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState({ status: 'done', integrity: source.integrityScope });
    } catch (error) {
      if (!current.signal.aborted) setState({ status: 'error', error });
    }
  };
  const cancel = () => {
    controller.current?.abort();
    setState({ status: 'idle' });
  };
  return { state, start, cancel, dismiss: () => setState({ status: 'idle' }) };
}

/** A name the browser can save under: no separators, control or reserved characters, never empty. */
export function safeDownloadName(name: string): string {
  const cleaned = [...name]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
    .join('')
    .replace(/^[\s.]+|[\s.]+$/gu, '');
  return (cleaned || 'download').slice(0, 200);
}

function PreviewBody({
  details,
  mode,
  cached,
  converter,
  onIntegrity,
}: {
  details: ArchiveEntryDetails;
  mode: Exclude<ArchivePreviewMode, 'hex'>;
  cached: (kind: Exclude<ArchivePreviewKind, 'hex'>) => Promise<ArchivePreviewBytes>;
  converter: string;
  onIntegrity: (integrity: ArchivePreviewBytes['integrity']) => void;
}) {
  const kind = previewKind(mode) as Exclude<ArchivePreviewKind, 'hex'>;
  const load = useCallback(() => cached(kind), [cached, kind]);
  const { state, reload } = useAsync(load);
  const integrity = state.status === 'success' ? state.data.integrity : null;
  useEffect(() => {
    if (integrity) onIntegrity(integrity);
  }, [integrity, onIntegrity]);
  if (state.status === 'loading') return <LoadingState label="Reading the file" />;
  if (state.status === 'error') return <PreviewProblem error={state.error} onRetry={reload} />;
  const preview: ArchivePreviewBytes = state.data;
  const { path } = details.entry;
  if (mode === 'image') return <ImageViewer preview={preview} path={path} converter={converter} />;
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

function Breadcrumb({ crumbs, onReveal }: { crumbs: Crumb[]; onReveal: (rowKey: string) => void }) {
  if (crumbs.length <= 1) return null;
  return (
    <nav className="archive-breadcrumb" aria-label="Location">
      <ol>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${index}:${crumb.label}`}>
              {index > 0 ? (
                <ChevronRight size={12} aria-hidden="true" className="crumb-separator" />
              ) : null}
              {last || crumb.rowKey === null ? (
                <span
                  aria-current={last ? 'location' : undefined}
                  className={crumb.kind === 'archive' ? 'crumb-archive' : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  className={`crumb-link ${crumb.kind === 'archive' ? 'crumb-archive' : ''}`}
                  title={
                    crumb.kind === 'archive'
                      ? `Show the archive ${crumb.label}`
                      : `Show the directory ${crumb.label}`
                  }
                  onClick={() => onReveal(crumb.rowKey as string)}
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The right panel: one file, with a compact header, one contextual toolbar, the preview filling the rest, and a
 * status bar (decision 0058). Mounted once per selected file, so that choosing another file aborts what this one
 * still had in flight and nothing it receives late can replace the newer file. Its details and metadata are shown
 * on demand (the Info button), never above the preview.
 */
export function FilePanel({
  source,
  onBack,
  onReveal,
  onBrowse,
}: {
  source: FileSource;
  onBack: () => void;
  /** Shows a breadcrumb's directory or archive in the tree. */
  onReveal: (rowKey: string) => void;
  /** Opens this file, an archive, in the tree. */
  onBrowse: (rowKey: string) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      source.problem ? Promise.reject(new Error(source.problem)) : source.details(signal),
    [source],
  );
  const { state, reload } = useAsync(load);
  const [chosen, setChosen] = useState<ArchivePreviewMode | null>(null);
  const [verified, setVerified] = useState<ArchivePreviewBytes['integrity'] | null>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<HTMLDivElement | null>(null);
  const details = state.status === 'success' ? state.data : null;
  const download = useDownload(source);
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
    (kind: Exclude<ArchivePreviewKind, 'hex'>) => {
      let request = previews.current.get(kind);
      if (!request) {
        // Made on first use: a child's effect runs before this component's own.
        lifetime.current ??= new AbortController();
        request = source.preview(kind, lifetime.current.signal);
        // A failure is not kept: trying the mode again asks again.
        request.catch(() => previews.current.delete(kind));
        previews.current.set(kind, request);
      }
      return request;
    },
    [source],
  );
  const onIntegrity = useCallback((integrity: ArchivePreviewBytes['integrity']) => {
    setVerified((current) =>
      current === 'verified' || current === 'complete' ? current : integrity,
    );
  }, []);
  const readHex = useCallback(
    (offset: number, signal: AbortSignal) => source.hex(offset, signal),
    [source],
  );
  const mode = chosen && details?.modes.includes(chosen) ? chosen : (details?.modes[0] ?? null);
  const iconKind = fileIconKind(source.name, {
    archive: source.archiveRowKey !== null,
    detected: details?.detected.kind ?? null,
  });
  const entryName = details?.entry.name ?? source.name;

  return (
    <section className="archive-file-panel" aria-label={`File ${source.name}`}>
      <header className="archive-file-header">
        <IconButton icon={ArrowLeft} label="Back to files" className="d-md-none" onClick={onBack} />
        <FileTypeIcon kind={iconKind} size={20} className="flex-shrink-0" />
        <div className="min-w-0 flex-grow-1">
          <h3 className="archive-file-name" title={source.displayPath}>
            {source.name}
          </h3>
          <Breadcrumb crumbs={source.location} onReveal={onReveal} />
        </div>
      </header>
      <Toolbar label="File actions" className="archive-file-toolbar">
        {details && details.modes.length > 1 ? (
          <ToolbarGroup label="Preview mode">
            {details.modes.map((option) => (
              <IconToggleButton
                key={option}
                icon={MODES[option].icon}
                label={MODES[option].text}
                tooltip={MODES[option].tooltip}
                pressed={option === mode}
                onPressedChange={() => setChosen(option)}
              />
            ))}
          </ToolbarGroup>
        ) : null}
        {/* The current viewer's own controls arrive here. */}
        <div ref={setToolbar} className="icon-toolbar-slot" />
        <ToolbarSpacer />
        {source.archiveRowKey ? (
          <IconButton
            icon={FolderOpen}
            label="Browse this archive"
            onClick={() => onBrowse(source.archiveRowKey as string)}
          />
        ) : null}
        {details ? (
          download.state.status === 'running' ? (
            <IconButton icon={X} label="Cancel the download" onClick={download.cancel} />
          ) : (
            <IconButton
              icon={Download}
              label="Download file"
              tooltip={details.download.allowed ? undefined : 'Too large to download on its own'}
              disabled={!details.download.allowed}
              onClick={() => void download.start(entryName)}
            />
          )
        ) : null}
        <InfoPopover icon={Info} label="File information" title={entryName} wide>
          {() => <FileFacts source={source} details={details} verified={verified} />}
        </InfoPopover>
      </Toolbar>
      {download.state.status === 'error' ? (
        <div
          className="alert alert-warning small py-1 px-2 mb-0 d-flex align-items-center gap-2"
          role="alert"
        >
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="flex-grow-1">
            {problemText(download.state.error, 'The download failed.')}
          </span>
          <IconButton icon={X} label="Dismiss" onClick={download.dismiss} />
        </div>
      ) : null}
      <ViewerChromeContext.Provider
        value={{ toolbar, status, integrityScope: source.integrityScope }}
      >
        <div className="archive-preview" data-mode={mode ?? 'none'}>
          {source.problem ? (
            <div className="alert alert-secondary small" role="status">
              {source.problem} Its details are under File information.
            </div>
          ) : null}
          {state.status === 'loading' && !source.problem ? (
            <LoadingState label="Reading the file’s details" />
          ) : null}
          {state.status === 'error' && !source.problem ? (
            <PreviewProblem error={state.error} onRetry={reload} />
          ) : null}
          {details && mode ? (
            mode === 'hex' ? (
              <HexViewer read={readHex} details={details} />
            ) : (
              <PreviewBody
                key={mode}
                details={details}
                mode={mode}
                cached={cached}
                converter={source.origin === 'nested' ? 'in your browser' : 'by the server'}
                onIntegrity={onIntegrity}
              />
            )
          ) : null}
        </div>
        <footer className="archive-status-bar" aria-label="File status">
          {details && details.detected.kind === 'binary' ? (
            <StatusItem icon={null}>
              No preview for this kind of file: its bytes are shown.
            </StatusItem>
          ) : null}
          {details
            ? Object.values(details.unavailable).map((reason) => (
                <StatusItem key={reason} tone="warning">
                  {reason} Only the hexadecimal view is available.
                </StatusItem>
              ))
            : null}
          {details && !details.download.allowed ? (
            <StatusItem tone="warning">{downloadRefusal(details)}</StatusItem>
          ) : null}
          {download.state.status === 'running' ? (
            <StatusItem tone="info" icon={Download} live>
              Downloading: {formatBytes(download.state.received)} of{' '}
              {formatBytes(details?.entry.sizeBytes ?? 0)}
            </StatusItem>
          ) : null}
          {download.state.status === 'done' ? (
            <StatusItem tone="success" live>
              {download.state.integrity === 'server'
                ? 'Downloaded and verified.'
                : download.state.integrity === 'nested-crc'
                  ? 'Saved from the nested archive, after matching its CRC-32.'
                  : 'Saved from the nested archive (its format records no checksum).'}
            </StatusItem>
          ) : null}
          <div ref={setStatus} className="archive-status-slot" />
        </footer>
      </ViewerChromeContext.Provider>
    </section>
  );
}
