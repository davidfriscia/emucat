import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { pdfjsAssets } from './pdfjs-assets';
import { vditorAssets } from './vditor-assets';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed values are read, so the database passwords in .env stay out of the build.
  const env = loadEnv(mode, repositoryRoot, 'VITE_');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000';
  const proxy = { '/api': { target: apiTarget, changeOrigin: false } };

  return {
    envDir: repositoryRoot,
    resolve: {
      alias: {
        // The archive worker needs only the contracts' byte-level helpers (content detection, text decoding), which
        // import nothing at run time. Importing them directly keeps zod and every schema out of the worker
        // (decision 0058). The package itself is unchanged.
        '@emucat/contracts/archive-preview': fileURLToPath(
          new URL('../../packages/contracts/dist/archive-preview.js', import.meta.url),
        ),
      },
    },
    plugins: [react(), vditorAssets(), pdfjsAssets()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    build: {
      rolldownOptions: {
        output: {
          // The PDF.js worker is an ES module named `.mjs`. The web container's nginx maps only `.js` to
          // JavaScript, and a browser refuses a module worker served as anything else, so assets that are
          // JavaScript modules are named `.js` (decision 0056).
          assetFileNames: (asset: { names?: string[]; name?: string }) =>
            (asset.names?.[0] ?? asset.name ?? '').endsWith('.mjs')
              ? 'assets/[name]-[hash].js'
              : 'assets/[name]-[hash][extname]',
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
    },
  };
});
