import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '../..');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@epagoge/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
      '@epagoge/crypto': path.resolve(repoRoot, 'packages/crypto/src/index.ts'),
      '@epagoge/ai': path.resolve(repoRoot, 'packages/ai/src/index.ts'),
      '@epagoge/components': path.resolve(repoRoot, 'packages/components/src/index.ts'),
      '@epagoge/codegen': path.resolve(repoRoot, 'packages/codegen/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
