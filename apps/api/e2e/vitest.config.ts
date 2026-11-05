import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The tests in the file are one scenario, in order, around one running agent.
    sequence: { concurrent: false, shuffle: false },
  },
});
