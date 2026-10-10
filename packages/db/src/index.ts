import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export * from './generated/prisma/client';
export * from './domain';

let client: PrismaClient | undefined;

/** Shared Prisma client. Reads DATABASE_URL at first use. */
export function getDb(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}
