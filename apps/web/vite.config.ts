import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed values are read, so the database passwords in .env stay out of the build.
  const env = loadEnv(mode, repositoryRoot, 'VITE_');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000';
  const proxy = { '/api': { target: apiTarget, changeOrigin: false } };

  return {
    envDir: repositoryRoot,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
    },
  };
});
