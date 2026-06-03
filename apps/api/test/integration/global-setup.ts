/**
 * Vitest globalSetup for the integration suite. Runs ONCE, before any test
 * file, in the main process:
 *
 *   1. Drop + recreate the `txn_system_test` database (clean slate per run).
 *   2. Apply every migration to it via `prisma migrate deploy` — which also
 *      provisions the non-superuser `txn_app_rls` role's grants, so RLS is
 *      exercised exactly as in production.
 *
 * The dev database is never touched. Requires the Postgres cluster to be up
 * (`pnpm docker:up`) and `psql` on PATH.
 */
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, maintenanceSuperUrl, testDbName, testSuperUrl } from './test-db';

export default function setup(): void {
  const run = (file: string, args: string[], extraEnv?: Record<string, string>) =>
    execFileSync(file, args, {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
    });

  // 1. Recreate the test DB. FORCE drops any lingering connections (Postgres 13+).
  const psql = (sql: string) =>
    run('psql', [maintenanceSuperUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  psql(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
  psql(`CREATE DATABASE "${testDbName}"`);

  // 2. Migrate the fresh DB (the migrate:deploy script reads DATABASE_MIGRATIONS_URL).
  run('pnpm', ['--filter', '@app/db', 'migrate:deploy'], {
    DATABASE_MIGRATIONS_URL: testSuperUrl,
  });
}
