import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Settings live in the repo-root .env, shared by every app. Next only reads apps/web/.env*,
// so load the root file here (variables already set in the environment win).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@binwise/core', '@binwise/mock'],
};

export default nextConfig;
