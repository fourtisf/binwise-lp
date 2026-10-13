import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://kovra@localhost:5432/kovra_test_api',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
    },
  },
});
