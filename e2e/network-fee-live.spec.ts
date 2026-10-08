import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

/**
 * LIVE scenario run of the network fee through the real stack (browser → web →
 * API → Postgres with RLS). Two companies with IDENTICAL commission pricing:
 *   A — the network fee is switched ON (through the admin UI), OFF, and ON again;
 *   B — never has it (the "everything stays like before" control).
 * Every step asserts the exact money split AND the wallet to the cent, then the
 * whole run must reconcile (ledger == wallets) and the NETWORK_FEE ledger must
 * equal the sum of every network fee charged (minus the one refunded).
 *
 * Pricing for both companies:
 *   deposits     $2 fixed, deducted      withdrawals  $2 fixed, on top
 *   payouts      1%, deducted            loads        $1 fixed, deducted
 * Network fee on A: deposits 1% · withdrawals $1 · payouts 0.5% · loads $0.50
 */

const NEW_PASSWORD = 'newpass-123';
const num = (s: string | number | undefined | null) => Number(s ?? 0);
const near = (actual: string | number | undefined | null, expected: number, what = '') =>
  expect(num(actual), what).toBeCloseTo(expected, 6);

function cash(amount: string) {
  return {
    amount,
    currency: 'USD',
    payout: {
      method: 'CASH',
      recipientName: 'Live Payee',
      recipientPhone: '+9610000000',
      pickupLocation: 'Live Branch',
    },
  };
}

async function call(
  api: APIRequestContext,
  csrf: string,
  method: 'post' | 'put',
  path: string,
  body: Record<string, unknown> = {},
) {
  const res = await api[method](path, { headers: { 'x-csrf-token': csrf }, data: body });
  const text = await res.text();
  return { status: res.status(), body: text ? unwrap(JSON.parse(text)) : null };
}

interface Party {
  companyId: string;
  slug: string;
  owner: APIRequestContext;
  csrf: string;
}

test.describe.serial('network fee — live scenarios (ON → OFF → ON, with an OFF control)', () => {
  let admin: { api: APIRequestContext; csrf: string };
  let key: string;
  let A: Party;
  let B: Party;
  // Every network fee A is charged, kept in step with the scenarios below.
  let networkCharged = 0;

  const wallet = async (p: Party) => {
    const rows = unwrap(await (await p.owner.get('/v1/company/wallets')).json()).data;
    const usd = rows.find((w: { currency: string }) => w.currency === 'USD');
    return { available: num(usd.availableBalance), reserved: num(usd.reservedBalance) };
  };
  const expectWallet = async (p: Party, available: number, reserved = 0, what = '') => {
    const w = await wallet(p);
    near(w.available, available, `${what} available`);
    near(w.reserved, reserved, `${what} reserved`);
  };
  const deposit = async (p: Party, amount: string) => {
    const ext = `live-${p.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await ingestTransaction('omt', key, {
      companySlug: p.slug,
      externalTransactionId: ext,
      amount,
      currency: 'USD',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // The source never sees any fee.
    for (const k of ['commissionAmount', 'networkFeeAmount', 'netAmount']) {
      expect(r.body).not.toHaveProperty(k);
    }
    const list = unwrap(
      await (await p.owner.get('/v1/company/transactions?pageSize=100')).json(),
    ).data;
    return list.find((t: { externalTransactionId: string }) => t.externalTransactionId === ext);
  };
  const approve = async (flow: 'withdrawals' | 'payouts' | 'loads', id: string) => {
    const r = await call(admin.api, admin.csrf, 'post', `/v1/admin/${flow}/${id}/approve`, {
      externalReference: `live-${flow}-${id.slice(0, 8)}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('COMPLETED');
    return r.body;
  };
  const setNetworkFee = async (body: Record<string, unknown>) => {
    const r = await call(
      admin.api,
      admin.csrf,
      'put',
      `/v1/admin/companies/${A.companyId}/network-fee`,
      body,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  test.beforeAll(async () => {
    admin = await adminApiContext();
    const omt = await findSourceId(admin.api, 'omt');
    key = await createSourceKey(admin.api, admin.csrf, omt, `live-nf-${Date.now()}`);
    const party = async (): Promise<Party> => {
      const co = await provisionCompanyOwner(admin);
      await enableSourceForCompany(admin.api, admin.csrf, omt, co.companyId);
      const rule = (
        operationType: string,
        feeApplication: string,
        commissionType: string,
        commissionValue: string,
      ) =>
        createCommissionRule(admin.api, admin.csrf, {
          companyId: co.companyId,
          operationType,
          feeApplication,
          minAmount: '0',
          maxAmount: null,
          commissionType,
          commissionValue,
        });
      await rule('TRANSACTION', 'DEDUCTED', 'FIXED', '2');
      await rule('WITHDRAWAL', 'ON_TOP', 'FIXED', '2');
      await rule('PAYOUT', 'DEDUCTED', 'PERCENTAGE', '1');
      await rule('LOAD', 'DEDUCTED', 'FIXED', '1');
      const owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, NEW_PASSWORD);
      return { companyId: co.companyId, slug: co.slug, owner, csrf: await getCsrf(owner) };
    };
    A = await party();
    B = await party();
  });

  test.afterAll(async () => {
    await A?.owner.dispose();
    await B?.owner.dispose();
    await admin?.api.dispose();
  });

  test('1. switched OFF (the default): both companies book exactly the old way', async () => {
    for (const p of [A, B]) {
      const t = await deposit(p, '100');
      near(t.commissionAmount, 2);
      expect(t.networkFeeAmount).toBe('0');
      near(t.netAmount, 98);
      await expectWallet(p, 98, 0, 'after first deposit');
    }
    const cfg = unwrap(
      await (await admin.api.get(`/v1/admin/companies/${A.companyId}/network-fee`)).json(),
    );
    expect(cfg).toEqual({ enabled: false, rates: [] });
  });

  test('2. a super admin switches it ON for company A in the dashboard', async ({ page }) => {
    await configureInUi(page, A.companyId);
    const cfg = unwrap(
      await (await admin.api.get(`/v1/admin/companies/${A.companyId}/network-fee`)).json(),
    );
    expect(cfg).toEqual({
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
        { operationType: 'PAYOUT', feeType: 'PERCENTAGE', feeValue: '0.5' },
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '0.5' },
      ],
    });
    // The change is audited.
    const audit = unwrap(
      await (
        await admin.api.get(
          `/v1/admin/audit-logs?companyId=${A.companyId}&action=company.network_fee_updated`,
        )
      ).json(),
    );
    expect(audit.data[0].metadata.changes.networkFeeEnabled).toEqual({ from: false, to: true });
  });

  test('3. deposits on A carry both fees; B is untouched', async () => {
    // $100: commission 2, network 1% = 1 → credited 97.
    let t = await deposit(A, '100');
    near(t.commissionAmount, 2);
    near(t.networkFeeAmount, 1);
    near(t.netAmount, 97);
    networkCharged += 1;
    await expectWallet(A, 195, 0, 'A after $100');

    // $33.33: network 1% = 0.3333 → rounded once to 0.33 → credited 31.
    t = await deposit(A, '33.33');
    near(t.networkFeeAmount, 0.33);
    near(t.netAmount, 31);
    networkCharged += 0.33;
    await expectWallet(A, 226, 0, 'A after $33.33');

    // Tiny $2.01: commission 2 leaves 0.01 — the network fee (0.02) is capped at
    // 0.01 so the deposit still books, at net 0. It never fails.
    t = await deposit(A, '2.01');
    near(t.commissionAmount, 2);
    near(t.networkFeeAmount, 0.01);
    near(t.netAmount, 0);
    networkCharged += 0.01;
    await expectWallet(A, 226, 0, 'A after tiny deposit');

    // Control: B prices the same $100 exactly as before.
    t = await deposit(B, '100');
    expect(t.networkFeeAmount).toBe('0');
    near(t.netAmount, 98);
    await expectWallet(B, 196, 0, 'B after second deposit');
  });

  test('4. withdrawals on A: on top, reject and cancel all exact', async () => {
    // $50 on top: fee 2 + network 1 → wallet charged 53, recipient gets 50.
    const w = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('50'));
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    near(w.body.feeAmount, 2);
    near(w.body.networkFeeAmount, 1);
    near(w.body.netAmount, 50);
    near(w.body.totalAmount, 53);
    await expectWallet(A, 173, 53, 'A withdrawal reserved');
    const done = await approve('withdrawals', w.body.id);
    near(done.networkFeeAmount, 1);
    networkCharged += 1;
    await expectWallet(A, 173, 0, 'A withdrawal settled');

    // Rejected: the full 23 (20 + 2 + 1) comes back, no fee kept.
    const r = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('20'));
    await expectWallet(A, 150, 23, 'A before reject');
    expect(
      (
        await call(admin.api, admin.csrf, 'post', `/v1/admin/withdrawals/${r.body.id}/reject`, {
          notes: 'live',
        })
      ).status,
    ).toBe(201);
    await expectWallet(A, 173, 0, 'A after reject');

    // Cancelled by the company: same.
    const c = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('10'));
    await expectWallet(A, 160, 13, 'A before cancel');
    expect(
      (await call(A.owner, A.csrf, 'post', `/v1/company/withdrawals/${c.body.id}/cancel`, {}))
        .status,
    ).toBe(201);
    await expectWallet(A, 173, 0, 'A after cancel');

    // Control: B's $50 withdrawal costs 52 as before.
    const wb = await call(B.owner, B.csrf, 'post', '/v1/company/withdrawals', cash('50'));
    near(wb.body.totalAmount, 52);
    expect(wb.body.networkFeeAmount).toBe('0');
    await approve('withdrawals', wb.body.id);
    await expectWallet(B, 144, 0, 'B after withdrawal');
  });

  test('5. payouts and loads on A, and fees that would eat the whole amount are refused', async () => {
    // Payout $100 deducted: 1% = 1, network 0.5% = 0.5 → recipient gets 98.5.
    const p = await call(A.owner, A.csrf, 'post', '/v1/company/payouts', cash('100'));
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    near(p.body.feeAmount, 1);
    near(p.body.networkFeeAmount, 0.5);
    near(p.body.netAmount, 98.5);
    near(p.body.totalAmount, 100);
    await approve('payouts', p.body.id);
    networkCharged += 0.5;
    await expectWallet(A, 73, 0, 'A after payout');

    // Load $100 deducted: fee 1 + network 0.5 → credited 98.5; operator collects 100.
    const l = await call(A.owner, A.csrf, 'post', '/v1/company/loads', cash('100'));
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    near(l.body.networkFeeAmount, 0.5);
    near(l.body.netAmount, 98.5);
    near(l.body.totalAmount, 100);
    await approve('loads', l.body.id);
    networkCharged += 0.5;
    await expectWallet(A, 171.5, 0, 'A after load');

    // A $1.20 load: $1 fee + $0.50 network fee would leave nothing → refused
    // before anything happens, naming both fees.
    const bad = await call(A.owner, A.csrf, 'post', '/v1/company/loads', cash('1.20'));
    expect(bad.status).toBe(400);
    expect(String(bad.body.error?.message ?? JSON.stringify(bad.body))).toMatch(/network fee/);
    await expectWallet(A, 171.5, 0, 'A after refused load');
  });

  test('6. reversing a deposit refunds both fees and claws back only the net', async () => {
    const t = await deposit(A, '100'); // +97
    networkCharged += 1;
    await expectWallet(A, 268.5, 0, 'A before reversal');
    const rev = await call(
      admin.api,
      admin.csrf,
      'post',
      `/v1/admin/transactions/${t.id}/reverse`,
      {
        reason: 'live chargeback',
      },
    );
    expect(rev.status, JSON.stringify(rev.body)).toBe(201);
    networkCharged -= 1; // refunded
    await expectWallet(A, 171.5, 0, 'A after reversal');
  });

  test('7. switched OFF: new operations are back to the old pricing; a pending request keeps its fee', async () => {
    // Requested while ON: 15 + 2 + 1 = 18 reserved.
    const pending = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('15'));
    near(pending.body.networkFeeAmount, 1);
    await expectWallet(A, 153.5, 18, 'A pending while ON');

    await setNetworkFee({
      enabled: false,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
      ],
    });

    // New deposit after OFF: old pricing exactly.
    const t = await deposit(A, '100');
    expect(t.networkFeeAmount).toBe('0');
    near(t.netAmount, 98);
    await expectWallet(A, 251.5, 18, 'A deposit after OFF');

    // New withdrawal after OFF: 10 + 2 = 12, no network fee.
    const w = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('10'));
    expect(w.body.networkFeeAmount).toBe('0');
    near(w.body.totalAmount, 12);
    await approve('withdrawals', w.body.id);

    // The one requested while ON settles at the fee the company was shown.
    const done = await approve('withdrawals', pending.body.id);
    near(done.networkFeeAmount, 1);
    near(done.totalAmount, 18);
    networkCharged += 1;
    await expectWallet(A, 239.5, 0, 'A after OFF settlements');
  });

  test('8. switched ON again with a new rate: only new operations use it', async () => {
    await setNetworkFee({
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '3' }],
    });
    // Deposits are no longer charged (no deposit rate now).
    const t = await deposit(A, '100');
    expect(t.networkFeeAmount).toBe('0');
    near(t.netAmount, 98);
    // Withdrawal: 10 + 2 + 3 = 15.
    const w = await call(A.owner, A.csrf, 'post', '/v1/company/withdrawals', cash('10'));
    near(w.body.networkFeeAmount, 3);
    near(w.body.totalAmount, 15);
    await approve('withdrawals', w.body.id);
    networkCharged += 3;
    await expectWallet(A, 322.5, 0, 'A after re-enable');
  });

  test('9. the books balance: ledger == wallets, NETWORK_FEE == every network fee charged', async () => {
    const recon = await call(admin.api, admin.csrf, 'post', '/v1/admin/reconciliation/run', {});
    expect(recon.body.divergentCount).toBe(0);

    const sumAccount = async (companyId: string, accountType: string) => {
      let total = 0;
      for (let page = 1; ; page++) {
        const res = unwrap(
          await (
            await admin.api.get(
              `/v1/admin/companies/${companyId}/ledger?accountType=${accountType}&page=${page}&pageSize=100`,
            )
          ).json(),
        );
        for (const e of res.data) total += (e.direction === 'CREDIT' ? 1 : -1) * num(e.amount);
        if (page >= res.meta.totalPages) break;
      }
      return total;
    };
    near(await sumAccount(A.companyId, 'NETWORK_FEE'), networkCharged, 'A NETWORK_FEE ledger');
    near(await sumAccount(B.companyId, 'NETWORK_FEE'), 0, 'B NETWORK_FEE ledger');
    // B's commission revenue is exactly the old-system figure: 2 + 2 + 2 (withdrawal).
    near(await sumAccount(B.companyId, 'FEE'), 6, 'B FEE ledger');
  });

  test('10. the dashboard shows the network fee to admins, and nothing for the OFF company', async ({
    page,
  }) => {
    await page.goto(`/admin/deposits?companyId=${A.companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/\+\s*[\d.]+\s*network/).first()).toBeVisible({ timeout: 30_000 });
    await page.goto(`/admin/deposits?companyId=${B.companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/\+\s*[\d.]+\s*network/)).toHaveCount(0);
  });
});

/** Drive the admin "Network fee" card exactly as a super admin would. */
async function configureInUi(page: Page, companyId: string) {
  await page.goto(`/admin/companies/${companyId}`, { waitUntil: 'domcontentloaded' });
  const toggle = page.locator('#company-network-fee');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  const setRate = async (
    op: string,
    label: string,
    kind: 'Fixed amount ($)' | 'Percentage (%)',
    value: string,
  ) => {
    await page
      .getByRole('group', { name: `${label} fee type` })
      .getByRole('button', { name: kind })
      .click();
    await page.locator(`#network-fee-${op}`).fill(value);
  };
  await setRate('TRANSACTION', 'Deposits', 'Percentage (%)', '1');
  await setRate('WITHDRAWAL', 'Withdrawals', 'Fixed amount ($)', '1');
  await setRate('PAYOUT', 'Payouts', 'Percentage (%)', '0.5');
  await setRate('LOAD', 'Loads', 'Fixed amount ($)', '0.50');
  // Live example under the deposits rate: 1% of $100.
  await expect(page.locator('#network-fee-TRANSACTION-example')).toContainText('1');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Save network fee' }).click();
  await expect(page.getByText('Network fee saved')).toBeVisible({ timeout: 15_000 });
}
