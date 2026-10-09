import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Bundle the workspace client; keep the MCP SDK and zod as node_modules dependencies.
  noExternal: [/^@planner\//],
});
