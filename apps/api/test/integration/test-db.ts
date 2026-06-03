/**
 * Derives the connection strings for the **integration test database** from
 * the repo-root `.env`, without depending on any env loader.
 *
 * The tests never touch the dev database `txn_system`: they run against a
 * sibling `txn_system_test`, which `global-setup.ts` drops + recreates +
 * migrates once per run. We reuse the same Postgres cluster, roles, and
 * credentials as dev — only the database name changes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Walk up from `start` until the repo root (where docker-compose.yml lives). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'docker-compose.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`integration tests: could not locate repo root from ${start}`);
}

export const REPO_ROOT = findRepoRoot(process.cwd());

/** Minimal KEY=VALUE parser — enough for the handful of DB URLs we need. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = parseEnvFile(resolve(REPO_ROOT, '.env'));

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`integration tests: ${name} missing from .env`);
  return v;
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
function stripQuery(url: string): string {
  const u = new URL(url);
  u.search = '';
  return u.toString();
}

const baseRls = required('DATABASE_URL'); // non-superuser; RLS is enforced
const baseSuper = required('DATABASE_MIGRATIONS_URL'); // superuser; runs DDL

export const testDbName = `${dbNameOf(baseRls)}_test`;

/** Runtime (RLS, non-superuser) connection to the test DB — what the app uses. */
export const testRlsUrl = withDbName(baseRls, testDbName);

/** Superuser connection to the test DB — used by `prisma migrate deploy`. */
export const testSuperUrl = withDbName(baseSuper, testDbName);

/**
 * Superuser connection to the default `postgres` maintenance DB, used only to
 * CREATE/DROP the test database (query string stripped — libpq, not Prisma).
 */
export const maintenanceSuperUrl = stripQuery(withDbName(baseSuper, 'postgres'));
