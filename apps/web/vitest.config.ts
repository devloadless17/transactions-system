import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure helpers in `src/lib` — date maths that decides which
 * rows land in a money report, where a month boundary or a DST day is easy to
 * get subtly wrong and impossible to notice by eye.
 *
 * Mirrors the @app/api and @app/shared configs (`globals: false`, node
 * environment) so `pnpm -r test` behaves the same everywhere. No jsdom and no
 * component tests: those belong to the Playwright e2e suite, which exercises
 * the real app rather than a simulated DOM.
 */
export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
  resolve: {
    // Same '@/…' alias as tsconfig paths — vitest doesn't read tsconfig itself.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  esbuild: {
    target: 'es2022',
  },
});
