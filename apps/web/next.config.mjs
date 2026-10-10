/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@binwise/core', '@binwise/mock'],
};

export default nextConfig;
