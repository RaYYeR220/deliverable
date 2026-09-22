import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live tests talk to a rate-limited RPC; one file at a time keeps them under it.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
