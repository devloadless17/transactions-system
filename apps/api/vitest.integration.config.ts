import { defineConfig } from 'vitest/config';
import { testRlsUrl } from './test/integration/test-db';

/**
 * Opt-in integration suite. Separate from the default `vitest run` (unit
 * tests, no infra) so `pnpm test` stays green without a database — exactly
 * like the Playwright `e2e` suite is separate. Run with `pnpm test:int`,
 * which needs the Postgres cluster up (`pnpm docker:up`).
 *
 * globalSetup recreates + migrates the test DB; `env.DATABASE_URL` points the
 * app's PrismaService at it (RLS role, so RLS is actually enforced).
 */
export default defineConfig({
  test: {
    globals: false,
    include: ['test/integration/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/integration/global-setup.ts'],
    env: { DATABASE_URL: testRlsUrl, NODE_ENV: 'test' },
    fileParallelism: false, // DB-backed: run files sequentially for determinism
    hookTimeout: 60_000, // first run migrates the DB
    testTimeout: 30_000,
  },
  esbuild: { target: 'es2022' },
});
