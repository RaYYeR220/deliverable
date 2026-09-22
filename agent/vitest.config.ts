import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The gate ports are pure; nothing here needs a network or a wall clock.
    environment: 'node',
  },
});
