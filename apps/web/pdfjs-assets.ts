import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * PDF.js (https://github.com/mozilla/pdf.js, Apache-2.0) fetches a few data files at run time: Adobe CMaps for CJK
 * text, the standard 14 fonts, an ICC profile, and WebAssembly decoders for JBIG2 and JPEG 2000 images. Archive
 * Explorer (decision 0056) serves them from this application's own origin, under a path that names the version, like
 * Vditor's (decision 0053), so that a PDF preview loads nothing from a third party. The worker itself is bundled by
 * Vite.
 *
 * Left out on purpose: QuickJS (`quickjs-eval.*`), which only runs a PDF's own JavaScript. Scripting is never enabled.
 */
const PUBLISHED = ['cmaps', 'standard_fonts', 'iccs', 'wasm', 'LICENSE'] as const;
const EXCLUDED = /quickjs/i;

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjsVersion = (
  JSON.parse(readFileSync(join(pdfjsRoot, 'package.json'), 'utf8')) as { version: string }
).version;

/** Where the data files are served, with a trailing slash, as PDF.js wants its URLs. */
export const PDFJS_ASSETS = `/vendor/pdfjs/${pdfjsVersion}/`;

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

function publishedFiles(): string[] {
  return PUBLISHED.flatMap((entry) => filesUnder(join(pdfjsRoot, entry)))
    .map((file) => relative(pdfjsRoot, file).split(sep).join('/'))
    .filter((path) => !EXCLUDED.test(path));
}

const TYPES: Record<string, string> = {
  wasm: 'application/wasm',
  js: 'text/javascript; charset=utf-8',
  pfb: 'application/octet-stream',
  ttf: 'font/ttf',
  icc: 'application/vnd.iccprofile',
  bcmap: 'application/octet-stream',
};

export function pdfjsAssets(): Plugin {
  return {
    name: 'emucat-pdfjs-assets',
    config: () => ({ define: { __PDFJS_ASSETS__: JSON.stringify(PDFJS_ASSETS) } }),
    configureServer(server) {
      const allowed = new Set(publishedFiles());
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith(PDFJS_ASSETS)) return next();
        const path = decodeURIComponent(url.slice(PDFJS_ASSETS.length));
        // Only a file on the list: never a path the request made up.
        if (!allowed.has(path)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const extension = path.split('.').pop() ?? '';
        response.setHeader('content-type', TYPES[extension] ?? 'application/octet-stream');
        response.end(readFileSync(join(pdfjsRoot, path)));
      });
    },
    generateBundle() {
      for (const path of publishedFiles()) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_ASSETS.slice(1)}${path}`,
          source: readFileSync(join(pdfjsRoot, path)),
        });
      }
    },
  };
}
