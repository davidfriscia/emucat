import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Vditor loads some of its own files at run time (the Lute Markdown engine, its icons, the English strings, the
 * content themes and highlight.js) from `options.cdn`, which defaults to unpkg.com. EmuCat is self-hosted and loads
 * nothing from a third party, so these are served from the application's own origin instead, under a path that
 * names the version, and are cached for good like Vite's hashed bundles (decision 0053).
 *
 * Only the files below are published (KaTeX included, for formulas). Everything else in Vditor's `dist/js` (Mermaid,
 * MathJax, ECharts, Graphviz and the other diagram renderers) is left out: a fenced block of that kind stays code.
 */
const PUBLISHED = [
  'js/lute/lute.min.js',
  'js/i18n/en_US.js',
  'js/icons/ant.js',
  'js/highlight.js',
  'js/katex',
  'css/content-theme',
  'images',
] as const;

const require = createRequire(import.meta.url);
const vditorRoot = dirname(require.resolve('vditor/package.json'));
const vditorVersion = (
  JSON.parse(readFileSync(join(vditorRoot, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** The `cdn` option: Vditor appends `/dist/...` to it. */
export const VDITOR_CDN = `/vendor/vditor/${vditorVersion}`;

function filesUnder(path: string): string[] {
  const info = statSync(path);
  if (info.isFile()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** Every published file, as a path relative to Vditor's `dist`. */
function publishedFiles(): string[] {
  const dist = join(vditorRoot, 'dist');
  return PUBLISHED.flatMap((entry) => filesUnder(join(dist, entry))).map((file) =>
    relative(dist, file).split(sep).join('/'),
  );
}

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

export function vditorAssets(): Plugin {
  const prefix = `${VDITOR_CDN}/dist/`;
  return {
    name: 'emucat-vditor-assets',
    config: () => ({ define: { __VDITOR_CDN__: JSON.stringify(VDITOR_CDN) } }),
    configureServer(server) {
      const allowed = new Set(publishedFiles());
      const dist = resolve(vditorRoot, 'dist');
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith(prefix)) return next();
        const path = decodeURIComponent(url.slice(prefix.length));
        // Only a file on the list: never a path the request made up.
        if (!allowed.has(path)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const extension = path.split('.').pop() ?? '';
        response.setHeader('content-type', TYPES[extension] ?? 'application/octet-stream');
        response.end(readFileSync(join(dist, path)));
      });
    },
    generateBundle() {
      const dist = join(vditorRoot, 'dist');
      for (const path of publishedFiles()) {
        this.emitFile({
          type: 'asset',
          fileName: `${prefix.slice(1)}${path}`,
          source: readFileSync(join(dist, path)),
        });
      }
    },
  };
}
