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
