import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Env lives at the repo root (.env), shared by every app.
config({ path: '../../.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://binwise:binwise@localhost:5432/binwise',
  },
});
