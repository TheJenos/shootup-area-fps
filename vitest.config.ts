import { defineConfig } from 'vitest/config';

// Unit tests: pure code (the map generator) in Node. The game itself is tested end to end (e2e/).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
