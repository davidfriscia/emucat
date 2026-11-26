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
} from '@emucat/contracts';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Code,
  Copy,
  Maximize,
  Scan,
  WrapText,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ArchivePreviewBytes } from '../../api';
import { useAsync } from '../../useAsync';
import { formatBytes } from '../Agents';
import { LoadingState } from '../States';
import { IconButton, IconToggleButton, ToolbarGroup, ToolbarSeparator } from '../ui/IconButton';
import { IntegrityStatus, StatusItem, ViewerStatus, ViewerTools } from './chrome';
import { highlight, loadHighlighter, type HighlightJs } from './highlight';
import { sanitizeArchiveHtml } from './safe-html';
import { PreviewProblem } from './problems';

/**
 * The ways Archive Explorer shows one file (decisions 0056 and 0058). Every viewer shows bytes as data, whether the
 * server sent them or the browser's archive worker read them from a nested archive: text is text nodes (or sanitized
 * highlighting spans), HTML and SVG are source, images are drawn by the browser from a local object URL, and nothing
 * here ever runs, embeds or fetches what a file contains. Each viewer's controls go into the file's toolbar, and its
 * status into the status bar (`chrome.tsx`), so the preview itself fills the panel.
 */

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

  const encodingNote =
    encoding === initial.name
      ? initial.confidence === 'bom'
        ? 'from the byte-order mark'
        : initial.confidence === 'valid'
          ? 'valid throughout'
          : 'a guess from the bytes: choose another encoding if characters look wrong'
      : 'chosen by you';

  return (
    <div className="archive-viewer">
      <ViewerTools>
        <ToolbarSeparator />
        <ToolbarGroup label="Text options">
          <IconToggleButton
            icon={WrapText}
            label="Wrap lines"
            pressed={wrap}
            onPressedChange={setWrap}
          />
          {language ? (
            <IconToggleButton
              icon={Code}
              label={`Highlight (${language})`}
              pressed={colors}
              onPressedChange={setColors}
            />
          ) : null}
          <IconButton
            icon={copied === 'done' ? Check : Copy}
            label={copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy text'}
            onClick={() => void copy()}
          />
        </ToolbarGroup>
        <label htmlFor={`${ids}-encoding`} className="visually-hidden">
          Encoding
        </label>
        <select
          id={`${ids}-encoding`}
          className="form-select form-select-sm w-auto toolbar-select"
          value={encoding}
          title="Encoding"
          onChange={(event) => setEncoding(event.target.value as TextEncoding)}
        >
          {TEXT_ENCODINGS.map((name) => (
            <option key={name} value={name}>
              {TEXT_ENCODING_LABELS[name]}
              {name === initial.name ? ' (detected)' : ''}
            </option>
          ))}
        </select>
      </ViewerTools>
      <ViewerStatus>
        <StatusItem
          tone={
            initial.confidence === 'heuristic' && encoding === initial.name ? 'warning' : 'info'
          }
          icon={null}
        >
          {TEXT_ENCODING_LABELS[encoding]}, {encodingNote}.
        </StatusItem>
        {language ? <StatusItem icon={null}>{language}</StatusItem> : null}
      </ViewerStatus>
      <IntegrityStatus preview={preview} />
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
      <ViewerStatus>
        <StatusItem icon={null}>
          Rendered read-only: scripts, embedded HTML and images are removed, and links are not
          followed.
        </StatusItem>
      </ViewerStatus>
      <IntegrityStatus preview={preview} />
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

export function ImageViewer({
  preview,
  path,
  converter = 'by the server',
}: {
  preview: ArchivePreviewBytes;
  path: string;
  /** Who converted a legacy format: the server, or the browser for a file inside a nested archive. */
  converter?: string;
}) {
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
    <div className="archive-viewer archive-viewer-fill">
      <ViewerTools>
        <ToolbarSeparator />
        <ToolbarGroup label="Zoom">
          <IconToggleButton
            icon={Maximize}
            label="Fit to the panel"
            pressed={zoom === 'fit'}
            onPressedChange={() => setZoom('fit')}
          />
          <IconToggleButton
            icon={Scan}
            label="Actual size"
            pressed={zoom === 1}
            onPressedChange={() => setZoom(1)}
          />
          <IconButton icon={ZoomOut} label="Zoom out" onClick={() => step(-1)} />
          <IconButton icon={ZoomIn} label="Zoom in" onClick={() => step(1)} />
        </ToolbarGroup>
        <span className="toolbar-text" role="status">
          {current === null ? 'Fit' : `${Math.round(current * 100)}%`}
        </span>
      </ViewerTools>
      {image ? (
        <ViewerStatus>
          <StatusItem icon={null}>
            {image.format.toUpperCase()}, {image.width} × {image.height} pixels
            {image.converted ? `, converted to PNG ${converter} for display` : ''}
          </StatusItem>
        </ViewerStatus>
      ) : null}
      <IntegrityStatus preview={preview} />
      {failed ? (
        <div className="alert alert-warning small" role="alert">
          The browser could not display this image: it may be damaged, or a variant the browser does
          not read.
        </div>
      ) : null}
      <div className={`archive-image ${zoom === 'fit' ? 'archive-image-fit' : ''}`}>
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
  read,
  details,
}: {
  /** One window of bytes from `offset`: from the server, or from the browser's archive worker. */
  read: (offset: number, signal: AbortSignal) => Promise<ArchivePreviewBytes>;
  details: ArchiveEntryDetails;
}) {
  const ids = useId();
  const [offset, setOffset] = useState(0);
  const [charset, setCharset] = useState<'ascii' | 'cp437'>('ascii');
  const [target, setTarget] = useState('');
  const [targetProblem, setTargetProblem] = useState<string | null>(null);
  const { windowBytes, maxOffset, seekable } = details.hex;
  const size = details.entry.sizeBytes ?? 0;
  const load = useCallback((signal: AbortSignal) => read(offset, signal), [read, offset]);
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
      <ViewerTools>
        <ToolbarSeparator />
        <ToolbarGroup label="Move through the file">
          <IconButton
            icon={ChevronsLeft}
            label="Start of the file"
            disabled={offset === 0}
            onClick={() => go(0)}
          />
          <IconButton
            icon={ChevronLeft}
            label="Previous bytes"
            disabled={offset === 0}
            onClick={() => go(offset - windowBytes)}
          />
          <IconButton
            icon={ChevronRight}
            label="Next bytes"
            disabled={end >= size || end > maxOffset}
            onClick={() => go(offset + windowBytes)}
          />
        </ToolbarGroup>
        <form className="toolbar-form" onSubmit={submit}>
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
          <IconButton icon={ArrowRight} label="Go to the offset" type="submit" />
        </form>
        <ToolbarGroup label="Characters">
          {(['ascii', 'cp437'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`icon-button icon-button-text ${charset === option ? 'icon-button-pressed' : ''}`}
              aria-pressed={charset === option}
              onClick={() => setCharset(option)}
            >
              {option === 'ascii' ? 'ASCII' : 'CP437'}
            </button>
          ))}
        </ToolbarGroup>
      </ViewerTools>
      {targetProblem ? (
        <div
          className="alert alert-warning small py-1 px-2 mb-1 d-flex align-items-center gap-2"
          role="alert"
        >
          <span className="flex-grow-1">{targetProblem}</span>
          <IconButton icon={X} label="Dismiss" onClick={() => setTargetProblem(null)} />
        </div>
      ) : null}
      {!seekable && size > maxOffset + 1 ? (
        <ViewerStatus>
          <StatusItem tone="warning">
            Compressed entry: only the first {formatBytes(maxOffset + 1)} can be shown here, since
            reaching a byte means decompressing everything before it. Download the file to see the
            rest.
          </StatusItem>
        </ViewerStatus>
      ) : null}
      {state.status === 'loading' ? <LoadingState label="Reading bytes" /> : null}
      {state.status === 'error' ? <PreviewProblem error={state.error} /> : null}
      {state.status === 'success' ? (
        <>
          <ViewerStatus>
            <StatusItem icon={null} live>
              Bytes 0x{state.data.offset.toString(16)}–0x
              {Math.max(state.data.offset, end - 1).toString(16)} of {formatBytes(size)} (
              {size.toLocaleString('en')} bytes)
            </StatusItem>
          </ViewerStatus>
          <pre ref={scroller} className="archive-hex" tabIndex={0} aria-label="Hexadecimal bytes">
            {dump}
          </pre>
        </>
      ) : null}
    </div>
  );
}
