import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Migration lock-safety guard (deploy-readiness).
 *
 * A plain `CREATE INDEX` takes a SHARE lock for the WHOLE build; on an already-
 * large table (transactions, ledger_entries, …) that blocks live ingest/writes for
 * the duration. `migrate deploy` runs BEFORE the new app starts, while the old API
 * still serves traffic, so a plain index build on a hot table can stall the money
 * path. The safe pattern (docs/DEPLOYMENT.md → "Scaling & operational notes") is to
 * build it `CONCURRENTLY` out-of-band first, so the in-migration `CREATE INDEX IF
 * NOT EXISTS` then no-ops.
 *
 * This test FREEZES the set of already-shipped plain hot-table indexes. Any NEW one
 * fails here — forcing a deliberate choice: build it CONCURRENTLY out-of-band (the
 * migration IF-NOT-EXISTS then no-ops), or, if the table is still small, add it to
 * ALLOWLIST below with a justification. No infra needed — it just parses the SQL.
 */

const HOT_TABLES = new Set([
  'transactions',
  'ledger_entries',
  'withdrawals',
  'payouts',
  'loads',
  'whish_payments',
  'audit_logs',
  'transaction_logs',
]);

// Already-shipped plain (non-CONCURRENTLY) CREATE INDEX on a hot table, keyed
// `<migrationDir>:<indexName>`. These predate the guard; the forward rule is what
// matters. Do NOT add to this lightly — prefer CONCURRENTLY out-of-band.
const ALLOWLIST = new Set<string>([
  '0001_init:audit_logs_actor_id_idx',
  '0001_init:audit_logs_company_created_idx',
  '0001_init:audit_logs_entity_idx',
  '0001_init:ledger_entries_company_currency_created_idx',
  '0001_init:ledger_entries_transaction_id_idx',
  '0001_init:ledger_entries_withdrawal_id_idx',
  '0001_init:transactions_company_created_idx',
  '0001_init:transactions_company_status_idx',
  '0001_init:withdrawals_company_created_idx',
  '0001_init:withdrawals_company_status_idx',
  '0005_withdrawal_payout:withdrawals_payout_method_idx',
  '0009_split_withdrawals:ledger_entries_load_id_idx',
  '0009_split_withdrawals:ledger_entries_payout_id_idx',
  '0009_split_withdrawals:loads_company_created_idx',
  '0009_split_withdrawals:loads_company_status_idx',
  '0009_split_withdrawals:loads_payout_method_idx',
  '0009_split_withdrawals:payouts_company_created_idx',
  '0009_split_withdrawals:payouts_company_status_idx',
  '0009_split_withdrawals:payouts_payout_method_idx',
  '0010_whish_payments:whish_payments_company_created_idx',
  '0010_whish_payments:whish_payments_company_status_idx',
  '0019_perf_indexes:ledger_entries_receivable_idx',
  '0019_perf_indexes:transactions_completed_currency_created_idx',
  '0020_ledger_created_at:ledger_entries_created_at_idx',
  '0023_perf_indexes_and_commission_bound:ledger_entries_fee_currency_created_idx',
  '0023_perf_indexes_and_commission_bound:loads_completed_currency_processed_idx',
  '0023_perf_indexes_and_commission_bound:payouts_completed_currency_processed_idx',
  '0023_perf_indexes_and_commission_bound:withdrawals_completed_currency_processed_idx',
  '0024_ops_and_search_indexes:loads_pending_created_idx',
  '0024_ops_and_search_indexes:payouts_pending_created_idx',
  '0024_ops_and_search_indexes:transactions_external_id_trgm_idx',
  '0024_ops_and_search_indexes:transactions_reversed_updated_idx',
  '0024_ops_and_search_indexes:withdrawals_pending_created_idx',
  '0029_transaction_logs:transaction_logs_kind_created_at_idx',
  '20260610120000_restore_perf_indexes:ledger_entries_created_at_idx',
  '20260610120000_restore_perf_indexes:transaction_logs_created_at_idx',
  '20260610120000_restore_perf_indexes:transactions_external_id_trgm_idx',
  '20260611170000_admin_list_created_at_indexes:loads_created_at_idx',
  '20260611170000_admin_list_created_at_indexes:payouts_created_at_idx',
  '20260611170000_admin_list_created_at_indexes:whish_payments_created_at_idx',
  '20260611170000_admin_list_created_at_indexes:withdrawals_created_at_idx',
  '20260619120000_transactions_list_indexes:transactions_company_status_created_idx',
  '20260619120000_transactions_list_indexes:transactions_created_at_idx',
  '20260622180000_activity_completed_created_indexes:loads_completed_created_idx',
  '20260622180000_activity_completed_created_indexes:payouts_completed_created_idx',
  '20260622180000_activity_completed_created_indexes:transactions_completed_created_idx',
  '20260622180000_activity_completed_created_indexes:withdrawals_completed_created_idx',
  '20260622230000_audit_logs_list_index:audit_logs_created_at_id_idx',
  '20260623120000_audit_logs_action_index:audit_logs_action_created_idx',
  '20260623130000_analytics_source_indexes:transactions_completed_source_created_idx',
  // 2026-07-03 audit fixes: tables still small at ship time; the migration file
  // carries CONCURRENTLY out-of-band commands for large deployments (build those
  // first and the in-migration IF NOT EXISTS no-ops).
  '20260703120000_analytics_settled_and_processed_indexes:transactions_settled_source_created_idx',
  '20260703120000_analytics_settled_and_processed_indexes:withdrawals_completed_processed_idx',
  '20260703120000_analytics_settled_and_processed_indexes:payouts_completed_processed_idx',
  '20260703120000_analytics_settled_and_processed_indexes:loads_completed_processed_idx',
  // Partial index over pricing_issue IS NOT NULL rows (net-0 compensation
  // queries): the resulting index is tiny by construction, and the migration
  // file carries the CONCURRENTLY out-of-band command for large deployments
  // (build it first and the in-migration IF NOT EXISTS no-ops).
  '20260826130000_pricing_issue_and_slug_history:transactions_pricing_issue_idx',
  // Partial index over the NETWORK_FEE ledger account (network-fee revenue
  // sums, the twin of 0023's FEE index): EMPTY when it ships — no company is
  // charged a network fee yet — and the migration file carries the
  // CONCURRENTLY out-of-band command for an already-large ledger.
  '20261008120700_network_fee_ledger_index:ledger_entries_network_fee_currency_created_idx',
  // Partial index over PENDING Whish links only (the reconciliation poller's
  // schedule): production has never had more than a handful pending at once,
  // so it is tiny by construction; the migration file carries the
  // CONCURRENTLY out-of-band command for a large table.
  '20261013120000_whish_payment_poll_schedule:whish_payments_pending_poll_idx',
]);

function migrationsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'packages/db/prisma/migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate packages/db/prisma/migrations from cwd=${process.cwd()}`);
}

/** All plain (non-CONCURRENTLY) CREATE INDEX statements on a hot table. */
function collectPlainHotIndexes(): Set<string> {
  const root = migrationsDir();
  const found = new Set<string>();
  for (const d of fs.readdirSync(root)) {
    const file = path.join(root, d, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8').replace(/^\s*--.*$/gm, '');
    for (const stmt of sql.split(';')) {
      if (!/create\s+index/i.test(stmt)) continue;
      if (/concurrently/i.test(stmt)) continue; // safe — non-blocking build
      const name = stmt.match(/create\s+index\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/i)?.[1];
      const table = stmt.match(/\bon\s+"?([a-z0-9_]+)"?/i)?.[1];
      if (name && table && HOT_TABLES.has(table)) found.add(`${d}:${name}`);
    }
  }
  return found;
}

describe('migration lock-safety: no NEW plain CREATE INDEX on a hot table', () => {
  const found = collectPlainHotIndexes();

  it('every plain hot-table index is allow-listed (a new one must build CONCURRENTLY out-of-band)', () => {
    const offenders = [...found].filter((x) => !ALLOWLIST.has(x)).sort();
    expect(
      offenders,
      `New plain CREATE INDEX on a hot table detected: ${offenders.join(', ')}.\n` +
        `On a populated table this SHARE-locks live writes for the whole build. Build it ` +
        `\`CREATE INDEX CONCURRENTLY\` out-of-band first (the in-migration IF NOT EXISTS then ` +
        `no-ops) per docs/DEPLOYMENT.md, OR — only if the table is still small — add it to ` +
        `ALLOWLIST in this spec with a justification.`,
    ).toEqual([]);
  });

  it('the allow-list has no stale entries (keeps it honest as migrations evolve)', () => {
    const stale = [...ALLOWLIST].filter((x) => !found.has(x)).sort();
    expect(
      stale,
      `ALLOWLIST entries no longer present in any migration: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * One live table per migration (deadlock guard).
 *
 * Prisma applies a migration file as ONE transaction, and a lock taken by a DDL
 * statement is held until that transaction commits. While the previous API
 * version is still serving, a file that locks two live tables can deadlock
 * against a money write that touches the same two in the opposite order — e.g.
 * an ingest holds `transactions`/`companies` and then, through the ledger's
 * foreign keys, needs `withdrawals`/`payouts`/`loads`. Postgres aborts one side;
 * when that is the migration, the deploy fails and every later deploy is blocked
 * until the failed migration is resolved by hand.
 *
 * A file that locks a single pre-existing table can only ever WAIT for it — it
 * can never be half of a cycle. So: a new migration may lock at most one table
 * that existed before it (tables it creates itself are not live yet). Split the
 * rest into one file per table, as 20261008120100…120700 (network fee) does.
 *
 * FROZEN lists the already-shipped files that predate this guard. They have run
 * everywhere and never run again, so they are harmless now; the forward rule is
 * what matters. Never add a new migration to it.
 */
const FROZEN_MULTI_TABLE = new Set<string>([
  '0002_rls_and_constraints',
  '0006_source_api_keys',
  '0009_split_withdrawals',
  '0010_whish_payments',
  '0011_whish_idempotency_webhooks',
  '0012_fees_and_cancel',
  '0015_company_sources',
  '0016_invariants_and_audit_fks',
  '0017_force_rls',
  '0018_status_transition_guards',
  '0019_perf_indexes',
  '0023_perf_indexes_and_commission_bound',
  '0024_ops_and_search_indexes',
  '0027_money_out_nonneg_checks',
  '20260609153054_nullable_requested_by',
  '20260610120000_restore_perf_indexes',
  '20260611170000_admin_list_created_at_indexes',
  '20260622180000_activity_completed_created_indexes',
  '20260624120000_admin_notes',
  '20260703120000_analytics_settled_and_processed_indexes',
  '20260708120908_',
  '20260812220000_money_scale_narrow_safe_columns',
  '20260826130000_pricing_issue_and_slug_history',
]);

/**
 * The pre-existing tables a migration takes a write-blocking lock on:
 * ALTER TABLE, a plain CREATE INDEX, CREATE TRIGGER, DROP TABLE, and the target
 * of a foreign key. Tables the file creates itself are left out.
 */
export function lockedLiveTables(sql: string): string[] {
  const body = sql.replace(/^\s*--.*$/gm, '');
  const created = new Set<string>();
  const locked = new Set<string>();
  const name = '"?([a-z0-9_]+)"?';
  for (const stmt of body.split(';')) {
    const createdTable = stmt.match(
      new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${name}`, 'i'),
    )?.[1];
    if (createdTable) created.add(createdTable);
    for (const m of stmt.matchAll(
      new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?${name}`, 'gi'),
    )) {
      locked.add(m[1]!);
    }
    if (/create\s+(?:unique\s+)?index/i.test(stmt) && !/concurrently/i.test(stmt)) {
      const table = stmt.match(new RegExp(`\\bon\\s+(?:only\\s+)?${name}`, 'i'))?.[1];
      if (table) locked.add(table);
    }
    if (/create\s+(?:constraint\s+)?trigger/i.test(stmt)) {
      const table = stmt.match(new RegExp(`\\bon\\s+${name}`, 'i'))?.[1];
      if (table) locked.add(table);
    }
    for (const m of stmt.matchAll(new RegExp(`references\\s+${name}`, 'gi'))) locked.add(m[1]!);
    for (const m of stmt.matchAll(
      new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${name}`, 'gi'),
    )) {
      locked.add(m[1]!);
    }
  }
  return [...locked].filter((t) => !created.has(t)).sort();
}

describe('migration lock-safety: a migration locks at most ONE live table', () => {
  const root = migrationsDir();
  const multi = new Map<string, string[]>();
  for (const d of fs.readdirSync(root)) {
    const file = path.join(root, d, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const tables = lockedLiveTables(fs.readFileSync(file, 'utf8'));
    if (tables.length > 1) multi.set(d, tables);
  }

  it('recognises the lock-taking statements (and ignores tables the file creates)', () => {
    expect(
      lockedLiveTables(`
        -- ALTER TABLE "commented_out" ADD COLUMN x INT;
        ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "x" INT;
        CREATE TABLE "fresh" ("id" UUID REFERENCES "companies" ("id"));
        ALTER TABLE "fresh" ENABLE ROW LEVEL SECURITY;
        CREATE INDEX IF NOT EXISTS "i" ON "ledger_entries" ("currency");
        CREATE INDEX CONCURRENTLY "j" ON "transactions" ("currency");
        CREATE TRIGGER "t" BEFORE UPDATE ON "loads" FOR EACH ROW EXECUTE FUNCTION f();
      `),
    ).toEqual(['companies', 'ledger_entries', 'loads', 'withdrawals']);
  });

  it('no new migration locks more than one pre-existing table (split it: one table per file)', () => {
    const offenders = [...multi.keys()].filter((d) => !FROZEN_MULTI_TABLE.has(d)).sort();
    expect(
      offenders,
      offenders.map((d) => `${d} locks ${multi.get(d)!.join(', ')}`).join('; ') +
        `.\nA migration file is one transaction and holds every lock until it commits; ` +
        `locking two live tables can deadlock against a money write while the previous API ` +
        `still serves, failing the deploy. Put each table in its own migration file.`,
    ).toEqual([]);
  });

  it('the frozen list has no stale entries', () => {
    const stale = [...FROZEN_MULTI_TABLE].filter((d) => !multi.has(d)).sort();
    expect(stale, `FROZEN_MULTI_TABLE entries that no longer apply: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('the network-fee migrations each lock a single table', () => {
    const networkFee = fs
      .readdirSync(root)
      .filter((d) => d.startsWith('20261008'))
      .sort();
    expect(networkFee).toHaveLength(8);
    for (const d of networkFee) {
      const tables = lockedLiveTables(fs.readFileSync(path.join(root, d, 'migration.sql'), 'utf8'));
      expect(tables.length, `${d} locks ${tables.join(', ')}`).toBeLessThanOrEqual(1);
    }
  });
});
