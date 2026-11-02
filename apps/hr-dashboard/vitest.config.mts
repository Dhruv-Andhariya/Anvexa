import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: { postcss: {} }, // unit tests don't need Tailwind; skip loading postcss.config.mjs
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
