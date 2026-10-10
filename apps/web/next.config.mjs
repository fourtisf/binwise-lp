import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Settings live in the repo-root .env, shared by every app. Next only reads apps/web/.env*,
// so take the NEXT_PUBLIC_* lines from the root file here (variables already set in the environment win).
// Nothing else is loaded: the web server doesn't need the agent's or the API's secrets.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@binwise/core', '@binwise/mock'],
};

export default nextConfig;
