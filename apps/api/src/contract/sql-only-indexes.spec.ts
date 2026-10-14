import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQL-only index guard.
 *
 * Some indexes cannot be declared in schema.prisma (an index on an expression,
 * or a partial one Prisma can't express), so they live only in migration SQL.
 * `prisma migrate dev` treats any index missing from schema.prisma as drift and
 * DROPS it in the next generated migration — it happened once already
 * (20260609153054_nullable_requested_by dropped two performance indexes; see
 * 20260610120000_restore_perf_indexes). Without them the search (and the Whish
 * poller's schedule) silently falls back to walking whole tables.
 *
 * So: no migration after the one that creates one of these may drop it. If a
 * generated migration does, delete those DROP lines before committing it.
 * No infra needed — it reads the migration files.
 */
const SQL_ONLY_INDEXES: Record<string, string> = {
  // index name → the migration that creates it
  whish_payments_pending_poll_idx: '20261013120000_whish_payment_poll_schedule',
  transactions_search_trgm_idx: '20261014150100_transactions_search_indexes',
  transactions_search_phones_trgm_idx: '20261014150100_transactions_search_indexes',
  withdrawals_search_trgm_idx: '20261014150200_withdrawals_search_indexes',
  withdrawals_search_phones_trgm_idx: '20261014150200_withdrawals_search_indexes',
  payouts_search_trgm_idx: '20261014150300_payouts_search_indexes',
  payouts_search_phones_trgm_idx: '20261014150300_payouts_search_indexes',
  loads_search_trgm_idx: '20261014150400_loads_search_indexes',
  loads_search_phones_trgm_idx: '20261014150400_loads_search_indexes',
};

function migrationsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'packages/db/prisma/migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate packages/db/prisma/migrations from cwd=${process.cwd()}`);
}

const root = migrationsDir();
const migrations = fs
  .readdirSync(root)
  .filter((d) => fs.existsSync(path.join(root, d, 'migration.sql')))
  .sort();
const sqlOf = (d: string) =>
  fs
    .readFileSync(path.join(root, d, 'migration.sql'), 'utf8')
    // comments may quote a DROP (e.g. an out-of-band command) — only SQL counts
    .replace(/--.*$/gm, '');

describe('SQL-only indexes are never drift-dropped', () => {
  it('each is created where the list says', () => {
    for (const [index, creator] of Object.entries(SQL_ONLY_INDEXES)) {
      expect(migrations, index).toContain(creator);
      expect(sqlOf(creator), index).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS "${index}"`));
    }
  });

  it('no later migration drops one', () => {
    const drops: string[] = [];
    for (const [index, creator] of Object.entries(SQL_ONLY_INDEXES)) {
      for (const d of migrations.filter((m) => m > creator)) {
        if (new RegExp(`DROP INDEX[^;]*"?${index}"?`, 'i').test(sqlOf(d)))
          drops.push(`${d} drops ${index}`);
      }
    }
    expect(drops).toEqual([]);
  });
});
