import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      BOT_TOKEN: 'test:0000000000:AABBCCDDEEFFaabbccddeeff',
      DATABASE_URL: ':memory:',
    },
    testTimeout: 10_000,
  },
});
