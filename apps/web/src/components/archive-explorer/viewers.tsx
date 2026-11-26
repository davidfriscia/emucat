import {
  CP437_CONTROL_GLYPHS,
  CP437_DELETE_GLYPH,
  CP437_HIGH,
  TEXT_ENCODINGS,
  TEXT_ENCODING_LABELS,
  decodeText,
  detectEncoding,
  type ArchiveEntryDetails,
  type TextEncoding,
  type VmIdentity,
} from '@emucat/contracts';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { fetchArchivePreview, type ArchiveFileRef, type ArchivePreviewBytes } from '../../api';
import { useAsync } from '../../useAsync';
import { formatBytes } from '../Agents';
import { LoadingState } from '../States';
import { highlight, loadHighlighter, type HighlightJs } from './highlight';
import { sanitizeArchiveHtml } from './safe-html';
import { PreviewProblem } from './problems';

/**
 * The ways Archive Explorer shows one file (decision 0056). Every viewer shows bytes the server sent as data: text is
 * text nodes (or sanitized highlighting spans), HTML and SVG are source, images are drawn by the browser from a local
 * object URL, and nothing here ever runs, embeds or fetches what a file contains.
 */

export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="archive-toolbar btn-toolbar gap-2 flex-wrap" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export function IntegrityNote({ preview }: { preview: ArchivePreviewBytes }) {
  if (preview.truncated) {
    return (
      <p className="small text-body-secondary mb-1" role="status">
        Showing the first {formatBytes(preview.bytes.length)} of {formatBytes(preview.totalBytes)}.
        Only this part was read: its structure was checked, but no checksum covers part of a file.
      </p>
    );
  }
  if (preview.integrity === 'verified') {
    return (
      <p className="small text-success-emphasis mb-1">
        The whole file was read and matched its recorded checksum.
      </p>
    );
  }
  return (
    <p className="small text-body-secondary mb-1">
      The whole file was read. This archive format records no checksum for it.
    </p>
  );
}

// --- Text ------------------------------------------------------------------------------------------------------

export function TextViewer({
  preview,
  path,
  language,
  detected,
}: {
  preview: ArchivePreviewBytes;
  path: string;
  language: string | null;
  detected: ArchiveEntryDetails['detected']['encoding'];
}) {
  const ids = useId();
  const initial = useMemo(
    () => detected ?? detectEncoding(preview.bytes, path),
    [detected, preview.bytes, path],
  );
  const [encoding, setEncoding] = useState<TextEncoding>(
    (TEXT_ENCODINGS as readonly string[]).includes(initial.name)
      ? (initial.name as TextEncoding)
      : 'utf-8',
  );
  const [wrap, setWrap] = useState(language === null || language === 'markdown');
  const [colors, setColors] = useState(language !== null);
  const [highlighter, setHighlighter] = useState<HighlightJs | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const text = useMemo(() => decodeText(preview.bytes, encoding), [preview.bytes, encoding]);

  useEffect(() => {
    if (!colors || !language) return;
    let current = true;
    void loadHighlighter().then((loaded) => {
      if (current) setHighlighter(loaded);
    });
    return () => {
      current = false;
    };
  }, [colors, language]);

  const html = useMemo(
    () => (colors && language && highlighter ? highlight(highlighter, text, language) : null),
    [colors, language, highlighter, text],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="archive-viewer">
      <Toolbar label="Text options">
        <div className="d-flex align-items-center gap-1">
          <label htmlFor={`${ids}-encoding`} className="small mb-0">
            Encoding
          </label>
          <select
            id={`${ids}-encoding`}
            className="form-select form-select-sm w-auto"
            value={encoding}
            onChange={(event) => setEncoding(event.target.value as TextEncoding)}
          >
            {TEXT_ENCODINGS.map((name) => (
              <option key={name} value={name}>
                {TEXT_ENCODING_LABELS[name]}
                {name === initial.name ? ' (detected)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-check form-switch small mb-0 align-self-center">
          <input
            id={`${ids}-wrap`}
            className="form-check-input"
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
          />
          <label className="form-check-label" htmlFor={`${ids}-wrap`}>
            Wrap lines
          </label>
        </div>
        {language ? (
          <div className="form-check form-switch small mb-0 align-self-center">
            <input
              id={`${ids}-colors`}
              className="form-check-input"
              type="checkbox"
              checked={colors}
              onChange={(event) => setColors(event.target.checked)}
            />
            <label className="form-check-label" htmlFor={`${ids}-colors`}>
              Highlight ({language})
            </label>
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary theme-button"
          onClick={() => void copy()}
        >
          {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy text'}
        </button>
      </Toolbar>
      <p className="small text-body-secondary mb-1">
        {TEXT_ENCODING_LABELS[encoding]}
        {encoding === initial.name
          ? initial.confidence === 'bom'
            ? ', from the byte-order mark.'
            : initial.confidence === 'valid'
              ? ', valid throughout.'
              : ', a guess from the bytes: choose another encoding if characters look wrong.'
          : ', chosen by you.'}
      </p>
      <IntegrityNote preview={preview} />
      <pre
        className={`archive-text hljs ${wrap ? 'archive-wrap' : ''}`}
        tabIndex={0}
        aria-label={`Contents of ${path}`}
      >
        {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}
      </pre>
    </div>
  );
}

// --- Markdown --------------------------------------------------------------------------------------------------

export function MarkdownViewer({ preview, path }: { preview: ArchivePreviewBytes; path: string }) {
  const text = useMemo(() => {
    const { name } = detectEncoding(preview.bytes, path);
    return decodeText(preview.bytes, name);
  }, [preview.bytes, path]);
  const render = useCallback(async () => {
    const { default: Vditor } = await import('vditor');
    const html = await Vditor.md2html(text, {
      cdn: __VDITOR_CDN__,
      mode: 'light',
      markdown: { sanitize: true, autoSpace: false, toc: false, mark: true },
    } as Parameters<typeof Vditor.md2html>[1]);
    return sanitizeArchiveHtml(html);
  }, [text]);
  const { state } = useAsync(render);
  return (
    <div className="archive-viewer">
      <p className="small text-body-secondary mb-1">
        Rendered read-only. Scripts, embedded HTML and images are removed, and links are not
        followed.
      </p>
      <IntegrityNote preview={preview} />
      {state.status === 'loading' ? <LoadingState label="Rendering" /> : null}
      {state.status === 'error' ? (
        <div className="alert alert-warning small" role="alert">
          The Markdown could not be rendered. Use the Text view instead.
        </div>
      ) : null}
      {state.status === 'success' ? (
        <div
          className="archive-markdown vditor-reset"
          role="document"
          aria-label={`Rendered ${path}`}
          dangerouslySetInnerHTML={{ __html: state.data }}
        />
      ) : null}
    </div>
  );
}

// --- Images ----------------------------------------------------------------------------------------------------

const ZOOMS = [0.25, 0.5, 1, 2, 4, 8];

export function ImageViewer({ preview, path }: { preview: ArchivePreviewBytes; path: string }) {
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLImageElement>(null);
  // The object URL lives exactly as long as this image shows these bytes, and is released with it.
  useEffect(() => {
    const blob = new Blob([preview.bytes as BlobPart], { type: preview.contentType });
    const created = URL.createObjectURL(blob);
    const image = element.current;
    if (image) image.src = created;
    return () => {
      image?.removeAttribute('src');
      URL.revokeObjectURL(created);
    };
  }, [preview.bytes, preview.contentType]);
  const image = preview.image;
  const current = zoom === 'fit' ? null : zoom;
  const step = (direction: 1 | -1) => {
    const now = current ?? 1;
    const next =
      direction > 0
        ? ZOOMS.find((value) => value > now)
        : [...ZOOMS].reverse().find((value) => value < now);
    if (next) setZoom(next);
  };
  return (
    <div className="archive-viewer">
      <Toolbar label="Image options">
        <div className="btn-group btn-group-sm" role="group" aria-label="Zoom">
          <button
            type="button"
            className={`btn ${zoom === 'fit' ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
            aria-pressed={zoom === 'fit'}
            onClick={() => setZoom('fit')}
          >
            Fit
          </button>
          <button
            type="button"
            className={`btn ${zoom === 1 ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
            aria-pressed={zoom === 1}
            onClick={() => setZoom(1)}
          >
            100%
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            aria-label="Zoom out"
            onClick={() => step(-1)}
          >
            −
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            aria-label="Zoom in"
            onClick={() => step(1)}
          >
            +
          </button>
        </div>
        <span className="small align-self-center" role="status">
          {current === null ? 'Fitted to the panel' : `${Math.round(current * 100)}%`}
        </span>
      </Toolbar>
      {image ? (
        <p className="small text-body-secondary mb-1">
          {image.format.toUpperCase()}, {image.width} × {image.height} pixels
          {image.converted ? ', converted to PNG by the server for display' : ''}.
        </p>
      ) : null}
      {failed ? (
        <div className="alert alert-warning small" role="alert">
          The browser could not display this image: it may be damaged, or a variant the browser does
          not read.
        </div>
      ) : null}
      <div className={`archive-image ${zoom === 'fit' ? 'archive-image-fit' : ''}`}>
        {
          <img
            ref={element}
            alt={`Preview of ${path}`}
            style={
              current !== null && image
                ? { width: image.width * current, height: image.height * current, maxWidth: 'none' }
                : undefined
            }
            className={current !== null && current > 1 ? 'archive-pixelated' : undefined}
            onError={() => setFailed(true)}
          />
        }
      </div>
    </div>
  );
}

// --- Hex -------------------------------------------------------------------------------------------------------

const ASCII = (byte: number) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.');
const CP437 = (byte: number) =>
  byte < 0x20
    ? (CP437_CONTROL_GLYPHS[byte] ?? '.')
    : byte === 0x7f
      ? CP437_DELETE_GLYPH
      : byte >= 0x80
        ? (CP437_HIGH[byte - 0x80] ?? '.')
        : String.fromCharCode(byte);

/** Sixteen bytes a row: offset, hex in two groups of eight, and the characters. */
export function hexDump(
  bytes: Uint8Array,
  start: number,
  charset: 'ascii' | 'cp437',
  digits: number,
): string {
  const glyph = charset === 'ascii' ? ASCII : CP437;
  const lines: string[] = [];
  for (let row = 0; row < bytes.length; row += 16) {
    const slice = bytes.subarray(row, row + 16);
    let hex = '';
    let chars = '';
    for (let index = 0; index < 16; index += 1) {
      const byte = slice[index];
      hex += byte === undefined ? '   ' : `${byte.toString(16).padStart(2, '0')} `;
      if (index === 7) hex += ' ';
      if (byte !== undefined) chars += glyph(byte);
    }
    lines.push(`${(start + row).toString(16).padStart(digits, '0')}  ${hex} ${chars}`);
  }
  return lines.join('\n');
}

function parseOffset(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const value = trimmed.startsWith('0x')
    ? Number.parseInt(trimmed.slice(2), 16)
    : /^[0-9]+$/.test(trimmed)
      ? Number(trimmed)
      : /^[0-9a-f]+h$/.test(trimmed)
        ? Number.parseInt(trimmed.slice(0, -1), 16)
        : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function HexViewer({
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
  const ids = useId();
  const [offset, setOffset] = useState(0);
  const [charset, setCharset] = useState<'ascii' | 'cp437'>('ascii');
  const [target, setTarget] = useState('');
  const [targetProblem, setTargetProblem] = useState<string | null>(null);
  const { windowBytes, maxOffset, seekable } = details.hex;
  const size = details.entry.sizeBytes ?? 0;
  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchArchivePreview({ emulatorType, vmName }, versionId, file, 'hex', { offset, signal }),
    [emulatorType, vmName, versionId, file, offset],
  );
  const { state } = useAsync(load);
  const digits = Math.max(8, Math.ceil(Math.log2(Math.max(size, 2)) / 4));
  const dump = useMemo(
    () =>
      state.status === 'success'
        ? hexDump(state.data.bytes, state.data.offset, charset, digits)
        : '',
    [state, charset, digits],
  );
  const scroller = useRef<HTMLPreElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [offset]);

  const go = (next: number) => {
    const aligned = Math.max(0, Math.min(next - (next % 16), maxOffset - (maxOffset % 16)));
    setOffset(aligned);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = parseOffset(target);
    if (value === null) {
      setTargetProblem('Enter a decimal offset, or a hexadecimal one such as 0x1F0.');
      return;
    }
    if (value > maxOffset) {
      setTargetProblem(
        seekable
          ? `The file ends at 0x${Math.max(0, size - 1).toString(16)}.`
          : `This entry is compressed: only its first ${formatBytes(maxOffset + 1)} can be shown.`,
      );
      return;
    }
    setTargetProblem(null);
    go(value);
  };
  const end = state.status === 'success' ? state.data.offset + state.data.bytes.length : offset;

  return (
    <div className="archive-viewer">
      <Toolbar label="Hexadecimal view options">
        <div className="btn-group btn-group-sm" role="group" aria-label="Move through the file">
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            disabled={offset === 0}
            onClick={() => go(0)}
          >
            Start
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            disabled={offset === 0}
            onClick={() => go(offset - windowBytes)}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            disabled={end >= size || end > maxOffset}
            onClick={() => go(offset + windowBytes)}
          >
            Next
          </button>
        </div>
        <form className="d-flex gap-1" onSubmit={submit}>
          <label htmlFor={`${ids}-offset`} className="visually-hidden">
            Go to offset
          </label>
          <input
            id={`${ids}-offset`}
            className="form-control form-control-sm archive-offset"
            placeholder="Offset, e.g. 0x1F0"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-outline-secondary theme-button">
            Go
          </button>
        </form>
        <div className="btn-group btn-group-sm" role="group" aria-label="Characters">
          {(['ascii', 'cp437'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`btn ${charset === option ? 'btn-primary' : 'btn-outline-secondary theme-button'}`}
              aria-pressed={charset === option}
              onClick={() => setCharset(option)}
            >
              {option === 'ascii' ? 'ASCII' : 'CP437'}
            </button>
          ))}
        </div>
      </Toolbar>
      {targetProblem ? (
        <p className="small text-danger mb-1" role="alert">
          {targetProblem}
        </p>
      ) : null}
      {!seekable && size > maxOffset + 1 ? (
        <p className="small text-body-secondary mb-1">
          This entry is deflated: reaching a byte means decompressing everything before it, so only
          the first {formatBytes(maxOffset + 1)} can be shown here. Download the file to see the
          rest.
        </p>
      ) : null}
      {state.status === 'loading' ? <LoadingState label="Reading bytes" /> : null}
      {state.status === 'error' ? <PreviewProblem error={state.error} /> : null}
      {state.status === 'success' ? (
        <>
          <p className="small text-body-secondary mb-1" role="status">
            Bytes 0x{state.data.offset.toString(16)}–0x
            {Math.max(state.data.offset, end - 1).toString(16)} of {formatBytes(size)} (
            {size.toLocaleString('en')} bytes).
          </p>
          <pre ref={scroller} className="archive-hex" tabIndex={0} aria-label="Hexadecimal bytes">
            {dump}
          </pre>
        </>
      ) : null}
    </div>
  );
}
