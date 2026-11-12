import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: { postcss: {} }, // unit tests don't need Tailwind; skip loading postcss.config.mjs
  // the same "@/..." alias as tsconfig.json (components import from @/lib/...)
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // components use the automatic JSX runtime, like Next.js
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
