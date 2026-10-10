import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // Workspace packages ship TypeScript sources, so bundle them in.
  noExternal: [/^@binwise\//],
});
