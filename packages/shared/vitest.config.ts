import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
  esbuild: {
    target: 'es2022',
  },
});
