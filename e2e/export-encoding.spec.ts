import { test, expect, type Page } from '@playwright/test';
import { API_BASE } from './helpers';

// Regression guards for two CSV-export bugs found in review:
//   1. Mojibake — a "•" in an invoice rendered as "â€¢" in Excel because the
//      stream had no UTF-8 BOM. Every export must now start with EF BB BF.
//   2. Ambiguous money columns — the withdrawal/payout/load export carried a bare
//      requested `amount` that silently equalled `net` (ON_TOP) or `total`
//      (DEDUCTED). It now mirrors the app: gross_amount / fee_amount / net_amount.
//
// GETs go through the browser context's admin cookies (page.request); exports are
// GET + @SkipResponseEnvelope, so the body is raw CSV, not the JSON envelope.

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function fetchCsv(page: Page, pathAndQuery: string) {
  const res = await page.request.get(`${API_BASE}/v1${pathAndQuery}`);
  expect(res.ok(), `${pathAndQuery} → ${res.status()}`).toBeTruthy();
  expect(res.headers()['content-type'] ?? '').toContain('text/csv');
  const buf = await res.body();
  return { buf, header: buf.subarray(3).toString('utf8').split('\n')[0].trim() };
}

test.describe('CSV exports: encoding + columns', () => {
  test.setTimeout(60_000);

  test('every export starts with a UTF-8 BOM', async ({ page }) => {
    const paths = [
      '/admin/withdrawals/export.csv',
      '/admin/payouts/export.csv',
      '/admin/loads/export.csv',
      '/admin/whish/payments/export.csv',
      '/admin/transactions/export.csv',
      '/admin/activity/export.csv',
    ];
    for (const p of paths) {
      const { buf } = await fetchCsv(page, p);
      expect(buf.subarray(0, 3).equals(BOM), `${p} missing UTF-8 BOM`).toBeTruthy();
    }
  });

  test('flow exports show gross/fee/net, not an ambiguous bare amount', async ({ page }) => {
    for (const p of [
      '/admin/withdrawals/export.csv',
      '/admin/payouts/export.csv',
      '/admin/loads/export.csv',
    ]) {
      const { header } = await fetchCsv(page, p);
      const cols = header.split(',');
      expect(cols, `${p} header`).toContain('gross_amount');
      expect(cols).toContain('fee_amount');
      expect(cols).toContain('net_amount');
      expect(cols).toContain('fee_application');
      // The confusing columns are gone.
      expect(cols, `${p} must not carry a bare 'amount'`).not.toContain('amount');
      expect(cols).not.toContain('total_amount');
    }
  });

  test('whish export has its columns and accepts the new filter params', async ({ page }) => {
    const { header } = await fetchCsv(page, '/admin/whish/payments/export.csv');
    const cols = header.split(',');
    for (const c of ['reference', 'company_id', 'status', 'currency', 'amount', 'invoice']) {
      expect(cols).toContain(c);
    }
    // The new query params are accepted (200, still CSV) — proves the plumbing.
    const filtered = await page.request.get(
      `${API_BASE}/v1/admin/whish/payments/export.csv` +
        `?search=abc&status=PAID&from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
    );
    expect(filtered.ok(), `filtered whish export → ${filtered.status()}`).toBeTruthy();
    expect(filtered.headers()['content-type'] ?? '').toContain('text/csv');
  });
});
