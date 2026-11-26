import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ArchivePreviewBytes } from '../../api';
import { LoadingState } from '../States';
import { IconButton, IconToggleButton, ToolbarGroup, ToolbarSeparator } from '../ui/IconButton';
import { IntegrityStatus, StatusItem, ViewerStatus, ViewerTools } from './chrome';

/**
 * PDF preview with PDF.js (Apache-2.0), loaded only when a PDF is opened (decision 0056). Pages are drawn on a canvas
 * and nothing else: no annotation layer (so no links, forms or actions), no text layer, no scripting (PDF.js only runs
 * a document's JavaScript through its viewer's scripting sandbox, which is never loaded here). The worker and every
 * data file come from this application's own origin. The document is destroyed, with its worker, when the file
 * changes or the dialog closes. A PDF inside a nested archive (decision 0058) is handed over as bytes the browser read
 * itself, the same way.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** A canvas never holds more than this, whatever the zoom: about 64 MiB of pixels. */
const MAX_CANVAS_PIXELS = 16_777_216;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export default function PdfViewer({
  preview,
  path,
}: {
  preview: ArchivePreviewBytes;
  path: string;
}) {
  const ids = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<'width' | number>('width');
  const [rendering, setRendering] = useState(false);
  /** What is being typed in the page box, until it is submitted; otherwise the box shows the current page. */
  const [pageInput, setPageInput] = useState<string | null>(null);

  useEffect(() => {
    const task = pdfjs.getDocument({
      // A copy: PDF.js hands its buffer to the worker.
      data: preview.bytes.slice(),
      cMapUrl: `${__PDFJS_ASSETS__}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${__PDFJS_ASSETS__}standard_fonts/`,
      wasmUrl: `${__PDFJS_ASSETS__}wasm/`,
      iccUrl: `${__PDFJS_ASSETS__}iccs/`,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: false,
      maxImageSize: MAX_CANVAS_PIXELS,
      canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    });
    let current = true;
    task.promise.then(
      (loaded) => {
        if (current) setDocument(loaded);
      },
      (error: unknown) => {
        if (!current) return;
        const name = (error as { name?: string }).name;
        setFailed(
          name === 'PasswordException'
            ? 'This PDF is password-protected, so it cannot be previewed. Download it instead.'
            : 'This PDF could not be read. It may be damaged, or use features the previewer does not support.',
        );
      },
    );
    return () => {
      current = false;
      setDocument(null);
      void task.destroy();
    };
  }, [preview.bytes]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | null = null;
    setRendering(true);
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (cancelled || !canvas.current) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const available = Math.max(200, (frame.current?.clientWidth ?? 800) - 16);
        let scale = zoom === 'width' ? available / base.width : zoom;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        // Never a canvas larger than the limit.
        const pixels = base.width * base.height * (scale * ratio) ** 2;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = pdfPage.getViewport({ scale: scale * ratio });
        const target = canvas.current;
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${Math.floor(viewport.width / ratio)}px`;
        target.style.height = `${Math.floor(viewport.height / ratio)}px`;
        renderTask = pdfPage.render({
          canvas: target,
          viewport,
          annotationMode: pdfjs.AnnotationMode.ENABLE,
        });
        await renderTask.promise;
      } catch (error) {
        if (!cancelled && (error as { name?: string }).name !== 'RenderingCancelledException') {
          setFailed('This page could not be drawn.');
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page, zoom]);

  const pages = document?.numPages ?? 0;
  const scale = zoom === 'width' ? null : zoom;
  const step = (direction: 1 | -1) => {
    const now = scale ?? 1;
    const next =
      direction > 0
        ? ZOOMS.find((value) => value > now)
        : [...ZOOMS].reverse().find((value) => value < now);
    if (next) setZoom(next);
  };

  return (
    <div className="archive-viewer">
      <ViewerTools>
        <ToolbarSeparator />
        <ToolbarGroup label="Pages">
          <IconButton
            icon={ChevronLeft}
            label="Previous page"
            disabled={page <= 1}
            onClick={() => {
              setPageInput(null);
              setPage((value) => value - 1);
            }}
          />
          <form
            className="toolbar-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(pageInput);
              if (Number.isInteger(value) && value >= 1 && value <= pages) setPage(value);
              setPageInput(null);
            }}
          >
            <label htmlFor={`${ids}-page`} className="visually-hidden">
              Page
            </label>
            <input
              id={`${ids}-page`}
              className="form-control form-control-sm archive-page"
              inputMode="numeric"
              value={pageInput ?? String(page)}
              onChange={(event) => setPageInput(event.target.value)}
            />
            <span className="toolbar-text" role="status">
              of {pages || '…'}
            </span>
          </form>
          <IconButton
            icon={ChevronRight}
            label="Next page"
            disabled={page >= pages}
            onClick={() => {
              setPageInput(null);
              setPage((value) => value + 1);
            }}
          />
        </ToolbarGroup>
        <ToolbarGroup label="Zoom">
          <IconToggleButton
            icon={Maximize}
            label="Fit to the width"
            pressed={zoom === 'width'}
            onPressedChange={() => setZoom('width')}
          />
          <IconButton icon={ZoomOut} label="Zoom out" onClick={() => step(-1)} />
          <IconButton icon={ZoomIn} label="Zoom in" onClick={() => step(1)} />
        </ToolbarGroup>
        <span className="toolbar-text">
          {scale === null ? 'Width' : `${Math.round(scale * 100)}%`}
        </span>
      </ViewerTools>
      <IntegrityStatus preview={preview} />
      <ViewerStatus>
        <StatusItem icon={null}>
          {pages ? `Page ${page} of ${pages}. ` : ''}Drawn as an image: links, forms, attachments
          and scripts in the PDF are not active.
        </StatusItem>
      </ViewerStatus>
      {failed ? (
        <div className="alert alert-warning small" role="alert">
          {failed}
        </div>
      ) : null}
      {!document && !failed ? <LoadingState label="Opening the PDF" /> : null}
      <div ref={frame} className="archive-pdf">
        <canvas ref={canvas} aria-label={`Page ${page} of ${path}`} role="img" hidden={!document} />
        {rendering ? <span className="visually-hidden">Drawing the page</span> : null}
      </div>
    </div>
  );
}
