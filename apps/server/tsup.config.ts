import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    backup: 'src/backup/backup-cli.ts',
    restore: 'src/backup/restore-cli.ts',
    'hash-password': 'src/security/hash-password-cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TS source, so bundle them into the server output.
  noExternal: [/^@planner\//],
});
