import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  depositSearchSql,
  flowSearchSql,
  searchCount,
  searchKeysetIds,
  searchPageIds,
  searchTerm,
} from './search';

describe('searchTerm — what an operator types', () => {
  it('a phone typed any way becomes its digits, leading zeros dropped', () => {
    for (const typed of ['+96170977661', '+961 70 977 661', '0096170977661', '961-70-977-661']) {
      expect(searchTerm(typed).digits).toBe('%96170977661%');
    }
    expect(searchTerm('70977661').digits).toBe('%70977661%'); // local, no country code
    expect(searchTerm('03 123 456').digits).toBe('%3123456%'); // national 0 dropped
    expect(searchTerm('(70) 977.661').digits).toBe('%70977661%');
  });

  it('too few digits, or anything not phone-like, is matched as text only', () => {
    expect(searchTerm('961').digits).toBeNull();
    expect(searchTerm('Hamza Badran').digits).toBeNull();
    expect(searchTerm('wt_kJPZzzKjyUmg').digits).toBeNull();
    expect(searchTerm('531d3c17').digits).toBeNull();
  });

  it('trims, and takes LIKE wildcards literally', () => {
    expect(searchTerm('  hamza  ').like).toBe('%hamza%');
    expect(searchTerm('50%').like).toBe('%50\\%%');
    expect(searchTerm('wt_kJ').like).toBe('%wt\\_kJ%');
    expect(searchTerm('a\\b').like).toBe('%a\\\\b%');
  });
});

describe('the SQL predicates call the indexed functions and bind every value', () => {
  // These calls MUST match the expressions the migrations index
  // (20261014150100…150400), or the trigram indexes are skipped.
  it('a flow row: its search text, and the recipient phone digits for a phone', () => {
    expect(flowSearchSql('$1', '$2')).toBe(
      '(flow_search_text(o.id, o.external_reference, o.notes, o.payout_details) ILIKE $1' +
        ' OR flow_search_phones(o.payout_details) LIKE $2)',
    );
    expect(flowSearchSql('$1', null)).not.toContain('flow_search_phones');
  });

  it('a deposit row: its search text, the phone digits, and (activity) its source', () => {
    const sql = depositSearchSql('$1', '$2', '$3');
    expect(sql).toContain(
      'deposit_search_text(o.id, o.external_transaction_id, o.payload) ILIKE $1',
    );
    expect(sql).toContain('deposit_search_phones(o.payload) LIKE $2');
    expect(sql).toContain('o.source_id = ANY($3::uuid[])');
    expect(depositSearchSql('$1', null)).not.toContain('source_id');
  });

  it('the indexed expressions in the migrations are exactly these calls', () => {
    let dir = process.cwd();
    for (let i = 0; i < 6 && !fs.existsSync(path.join(dir, 'packages/db/prisma/migrations')); i++) {
      dir = path.dirname(dir);
    }
    const migrations = path.join(dir, 'packages/db/prisma/migrations');
    const sqlOf = (name: string) =>
      fs.readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8');
    const strip = (x: string) => x.replace(/"/g, '');
    const deposits = strip(sqlOf('20261014150100_transactions_search_indexes'));
    expect(deposits).toContain(
      'deposit_search_text(id, external_transaction_id, payload) gin_trgm_ops',
    );
    expect(deposits).toContain('deposit_search_phones(payload) gin_trgm_ops');
    for (const m of [
      '20261014150200_withdrawals_search_indexes',
      '20261014150300_payouts_search_indexes',
      '20261014150400_loads_search_indexes',
    ]) {
      const sql = strip(sqlOf(m));
      expect(sql, m).toContain(
        'flow_search_text(id, external_reference, notes, payout_details) gin_trgm_ops',
      );
      expect(sql, m).toContain('flow_search_phones(payout_details) gin_trgm_ops');
    }
  });
});

describe('searched lists: page, count and export chunks', () => {
  const fakeTx = (rows: unknown[]) => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
      calls,
      tx: {
        async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
          calls.push({ sql, values });
          return rows as T;
        },
      },
    };
  };

  it('a page: the search AND every list filter, newest first, bound — never interpolated', async () => {
    const { tx, calls } = fakeTx([{ id: 'a' }, { id: 'b' }]);
    const ids = await searchPageIds(
      tx,
      'withdrawals',
      {
        companyId: 'co-1',
        status: 'PENDING',
        currency: 'USD',
        payoutMethod: 'WISH',
        from: '2026-10-01T00:00:00Z',
      },
      '+961 70 977 661',
      40,
      20,
    );
    expect(ids).toEqual(['a', 'b']);
    const { sql, values } = calls[0]!;
    expect(sql).toMatch(/FROM withdrawals o WHERE \(flow_search_text/);
    expect(sql).toMatch(/ORDER BY o\.created_at DESC, o\.id DESC LIMIT \$\d+ OFFSET \$\d+/);
    expect(values).toEqual([
      '%+961 70 977 661%',
      '%96170977661%',
      'co-1',
      'PENDING',
      'USD',
      'WISH',
      new Date('2026-10-01T00:00:00Z'),
      20,
      40,
    ]);
    expect(sql).not.toContain('977');
  });

  it('the count, and deposits use the deposit text (with the source filter)', async () => {
    const { tx, calls } = fakeTx([{ n: 7n }]);
    await expect(searchCount(tx, 'transactions', { sourceId: 'src-1' }, 'ali')).resolves.toBe(7);
    expect(calls[0]!.sql).toMatch(
      /SELECT COUNT\(\*\)::bigint AS n FROM transactions o WHERE \(deposit_search_text/,
    );
    expect(calls[0]!.sql).toContain('o.source_id = $2::uuid');
  });

  it('an export chunk continues after the cursor (keyset), newest first', async () => {
    const { tx, calls } = fakeTx([{ id: 'c' }]);
    const at = new Date('2026-10-02T13:25:50Z');
    await searchKeysetIds(tx, 'payouts', {}, 'Hamza', { createdAt: at, id: 'id-9' }, 500);
    expect(calls[0]!.sql).toContain(
      '(o.created_at < $2 OR (o.created_at = $2 AND o.id < $3::uuid))',
    );
    expect(calls[0]!.values).toEqual(['%Hamza%', at, 'id-9', 500]);
  });

  it('there is no cap: a broad search is answered, not refused', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
    const { tx } = fakeTx(many);
    await expect(searchPageIds(tx, 'loads', {}, '9', 0, 20)).resolves.toHaveLength(20);
  });
});
