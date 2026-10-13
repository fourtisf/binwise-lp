import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests use a real Postgres + Redis; they share one database, so run files in sequence.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://kovra@localhost:5432/kovra_test_agent',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/14',
    },
  },
});
