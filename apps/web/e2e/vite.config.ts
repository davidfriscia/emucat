import { fileURLToPath } from 'node:url';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';
import application from '../vite.config';

/**
 * The browser harness (decision 0058): Archive Explorer alone, built exactly as the application is (same plugins,
 * same asset names, same worker and PDF.js handling), into `e2e/dist`, so that the browser tests run the production
 * bundle. The harness page renders the dialog against whatever API serves `/api/v1`.
 */
export default defineConfig((env: ConfigEnv) => {
  const base = (application as (env: ConfigEnv) => UserConfig)(env);
  return {
    ...base,
    root: fileURLToPath(new URL('./harness', import.meta.url)),
    envDir: fileURLToPath(new URL('../../..', import.meta.url)),
    build: {
      ...base.build,
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4096,
    },
  };
});
