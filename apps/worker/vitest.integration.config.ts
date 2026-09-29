import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
