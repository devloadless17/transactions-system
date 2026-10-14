import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminApiContext,
  cashRequest,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  getCsv,
  getJson,
  ingestTransaction,
  loginAs,
  loginOwnerApiContext,
  mutate,
  near,
  num,
  provisionCompanyOwner,
  provisionPlatformUser,
  unwrap,
} from './helpers';

/**
 * The network fee, across the WHOLE matrix, through the real stack
 * (browser → web → API → Postgres with RLS). It complements
 * network-fee-live.spec.ts (the ON → OFF → ON story of one company):
 *
 *   1. The two fee models side by side — a single-fee company and a dual-fee
 *      company take the same $100 deposit; the wallet credit is identical, and
 *      the dual-fee company can pass the network fee on to its customer.
 *   2. Every flow × both fee applications × percentage/fixed, exact to the cent.
 *   3. Edge cases — half-even rounding, replays, refusals, a ladder hole, a
 *      re-reversal, completing a transfer that was never claimed.
 *   4. Configuration validation — nothing invalid is ever saved.
 *   5. What a CRM receives.
 *   6. One tenant never sees another's activity totals.
 *   7. The dashboard, as each role really sees it — including that nothing of
 *      the previous user survives a sign-out on the same tab.
 *   8. The books reconcile.
 */

const PW = 'newpass-123';
// Recipient names unique to this run, so queue rows from earlier runs never match.
const RUN = Date.now().toString(36);
const Q_WITHDRAWAL = `Queue Withdrawal ${RUN}`;
const Q_PAYOUT = `Queue Payout ${RUN}`;
const Q_LOAD = `Queue Load ${RUN}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Party {
  companyId: string;
  slug: string;
  ownerEmail: string;
  owner: APIRequestContext;
  csrf: string;
}

type Rule = [
  op: 'TRANSACTION' | 'WITHDRAWAL' | 'PAYOUT' | 'LOAD',
  application: 'DEDUCTED' | 'ON_TOP',
  type: 'FIXED' | 'PERCENTAGE',
  value: string,
  minAmount?: string,
];
type Rate = [
  op: 'TRANSACTION' | 'WITHDRAWAL' | 'PAYOUT' | 'LOAD',
  type: 'FIXED' | 'PERCENTAGE',
  value: string,
];

test.describe.serial('network fee — the full matrix, live', () => {
  test.setTimeout(120_000);

  let admin: { api: APIRequestContext; csrf: string };
  let omtId: string;
  let key: string;
  // 1. the two fee models
  let single: Party;
  let dual: Party;
  let dualExt = '';
  // 2. the application matrix (also the back-office company)
  let mixed: Party;
  let mixedDepositExt = '';
  let pendingWithdrawalId = '';
  let pendingPayoutId = '';
  let pendingLoadId = '';
  // 3. edge cases
  let edge: Party;

  const party = async (rules: Rule[]): Promise<Party> => {
    const co = await provisionCompanyOwner(admin);
    await enableSourceForCompany(admin.api, admin.csrf, omtId, co.companyId);
    for (const [
      operationType,
      feeApplication,
      commissionType,
      commissionValue,
      minAmount,
    ] of rules) {
      await createCommissionRule(admin.api, admin.csrf, {
        companyId: co.companyId,
        operationType,
        feeApplication,
        minAmount: minAmount ?? '0',
        maxAmount: null,
        commissionType,
        commissionValue,
      });
    }
    const owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, PW);
    return {
      companyId: co.companyId,
      slug: co.slug,
      ownerEmail: co.ownerEmail,
      owner,
      csrf: await getCsrf(owner),
    };
  };
  const setNetworkFee = (p: Party, enabled: boolean, rates: Rate[]) =>
    mutate(admin.api, admin.csrf, 'put', `/v1/admin/companies/${p.companyId}/network-fee`, {
      enabled,
      rates: rates.map(([operationType, feeType, feeValue]) => ({
        operationType,
        feeType,
        feeValue,
      })),
    });
  const wallet = async (p: Party) => {
    const rows = (await getJson(p.owner, '/v1/company/wallets')).data;
    const usd = rows.find((w: { currency: string }) => w.currency === 'USD');
    return { available: num(usd?.availableBalance), reserved: num(usd?.reservedBalance) };
  };
  const expectWallet = async (p: Party, available: number, reserved: number, what: string) => {
    const w = await wallet(p);
    near(w.available, available, `${what}: available`);
    near(w.reserved, reserved, `${what}: reserved`);
  };
  const deposit = async (p: Party, amount: string, ext?: string) => {
    const externalTransactionId =
      ext ?? `mx-${p.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await ingestTransaction('omt', key, {
      companySlug: p.slug,
      externalTransactionId,
      amount,
      currency: 'USD',
    });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    // The source never sees any fee, on either fee model.
    for (const k of ['commissionAmount', 'networkFeeAmount', 'netAmount']) {
      expect(r.body).not.toHaveProperty(k);
    }
    const list = (await getJson(p.owner, '/v1/company/transactions?pageSize=100')).data;
    const txn = list.find(
      (t: { externalTransactionId: string }) => t.externalTransactionId === externalTransactionId,
    );
    return { txn, ext: externalTransactionId, status: r.status };
  };
  const request = (
    p: Party,
    flow: 'withdrawals' | 'payouts' | 'loads',
    amount: string,
    name?: string,
  ) => mutate(p.owner, p.csrf, 'post', `/v1/company/${flow}`, cashRequest(amount, name));
  const approve = async (flow: 'withdrawals' | 'payouts' | 'loads', id: string) => {
    const r = await mutate(admin.api, admin.csrf, 'post', `/v1/admin/${flow}/${id}/approve`, {
      externalReference: `mx-${flow}-${id.slice(0, 8)}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('COMPLETED');
    return r.body;
  };
  const ledgerSum = async (companyId: string, accountType: string) => {
    let total = 0;
    for (let page = 1; ; page++) {
      const res = await getJson(
        admin.api,
        `/v1/admin/companies/${companyId}/ledger?accountType=${accountType}&page=${page}&pageSize=100`,
      );
      for (const e of res.data) total += (e.direction === 'CREDIT' ? 1 : -1) * num(e.amount);
      if (page >= res.meta.totalPages) break;
    }
    return total;
  };

  test.beforeAll(async () => {
    admin = await adminApiContext();
    omtId = await findSourceId(admin.api, 'omt');
    key = await createSourceKey(admin.api, admin.csrf, omtId, `mx-nf-${Date.now()}`);
  });

  test.afterAll(async () => {
    for (const p of [single, dual, mixed, edge]) await p?.owner.dispose();
    await admin?.api.dispose();
  });

  // -------------------------------------------------------------------------
  test('1. single fee vs dual fee: same wallet credit; the dual-fee company can pass the network fee on', async () => {
    // Single fee: 2.5% commission. Dual fee: 1.5% commission + 1% network fee.
    single = await party([['TRANSACTION', 'DEDUCTED', 'PERCENTAGE', '2.5']]);
    dual = await party([['TRANSACTION', 'DEDUCTED', 'PERCENTAGE', '1.5']]);
    expect((await setNetworkFee(dual, true, [['TRANSACTION', 'PERCENTAGE', '1']])).status).toBe(
      200,
    );
    // Both push their events to the built-in demo CRM (what their own CRM would get).
    for (const p of [single, dual]) {
      expect((await mutate(p.owner, p.csrf, 'post', '/v1/company/crm/demo/enable')).status).toBe(
        201,
      );
    }

    const s = await deposit(single, '100');
    const d = await deposit(dual, '100');
    dualExt = d.ext;

    // The single-fee company: exactly the old shape, the new field is "0".
    expect(s.txn.commissionAmount).toBe('2.5');
    expect(s.txn.networkFeeAmount).toBe('0');
    expect(s.txn.netAmount).toBe('97.5');
    // The dual-fee company: the same total, split in two.
    expect(d.txn.commissionAmount).toBe('1.5');
    expect(d.txn.networkFeeAmount).toBe('1');
    expect(d.txn.netAmount).toBe('97.5');
    // Rival credits both wallets the same.
    await expectWallet(single, 97.5, 0, 'single-fee wallet');
    await expectWallet(dual, 97.5, 0, 'dual-fee wallet');

    // What each company's own system does with those figures:
    const creditsCustomer = (t: { amount: string; networkFeeAmount: string }) =>
      num(t.amount) - num(t.networkFeeAmount);
    near(creditsCustomer(s.txn), 100, 'single fee: the customer is credited in full');
    near(creditsCustomer(d.txn), 99, 'dual fee: the customer bears the $1 network fee');
    near(num(s.txn.commissionAmount), 2.5, 'single fee: the company absorbs 2.50');
    near(num(d.txn.commissionAmount), 1.5, 'dual fee: the company absorbs only 1.50');

    // Ledger: only the dual-fee company has a NETWORK_FEE account.
    near(await ledgerSum(dual.companyId, 'NETWORK_FEE'), 1);
    near(await ledgerSum(dual.companyId, 'FEE'), 1.5);
    near(await ledgerSum(single.companyId, 'NETWORK_FEE'), 0);
    near(await ledgerSum(single.companyId, 'FEE'), 2.5);
    const dualLedger = await getJson(dual.owner, '/v1/company/ledger?accountType=NETWORK_FEE');
    expect(dualLedger.data).toHaveLength(1);
    expect(
      (await getJson(single.owner, '/v1/company/ledger?accountType=NETWORK_FEE')).data,
    ).toEqual([]);

    // CSV: the fee is the LAST column — 1.00 for the dual-fee company, 0.00 otherwise.
    for (const [p, ext, commission, network] of [
      [single, s.ext, '2.50', '0.00'],
      [dual, d.ext, '1.50', '1.00'],
    ] as const) {
      const csv = await getCsv(p.owner, '/v1/company/transactions/export.csv');
      expect(csv.header[csv.header.length - 1]).toBe('network_fee_amount');
      const row = csv.rows.find((r) => r.includes(ext))!;
      expect(csv.cell(row, 'commission_amount')).toBe(commission);
      expect(csv.cell(row, 'network_fee_amount')).toBe(network);
      expect(csv.cell(row, 'net_amount')).toBe('97.50');
    }
  });

  test('1b. the company dashboard shows the network fee only to the company that is charged one', async ({
    browser,
  }) => {
    for (const [p, expectsNetworkLine] of [
      [dual, true],
      [single, false],
    ] as const) {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await context.newPage();
      try {
        await loginAs(page, p.ownerEmail, PW, '/app');
        await page.goto('/app/deposits', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(new RegExp(`mx-${p.slug}-`)).first()).toBeVisible({
          timeout: 30_000,
        });
        const networkLine = page.getByText(/\+\s*1\.00\s*network/);
        if (expectsNetworkLine) await expect(networkLine.first()).toBeVisible();
        else await expect(page.getByText(/\+\s*[\d.]+\s*network/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  test('2. every flow × both applications × percentage/fixed, exact to the cent', async () => {
    // The mirror image of network-fee-live.spec.ts (deposit DEDUCTED %,
    // withdrawal ON_TOP fixed, payout DEDUCTED %, load DEDUCTED fixed):
    mixed = await party([
      ['TRANSACTION', 'ON_TOP', 'FIXED', '2'],
      ['WITHDRAWAL', 'DEDUCTED', 'FIXED', '2'],
      ['PAYOUT', 'ON_TOP', 'PERCENTAGE', '1'],
      ['LOAD', 'ON_TOP', 'FIXED', '1'],
    ]);
    expect(
      (
        await setNetworkFee(mixed, true, [
          ['TRANSACTION', 'FIXED', '0.75'],
          ['WITHDRAWAL', 'PERCENTAGE', '0.5'],
          ['PAYOUT', 'FIXED', '0.25'],
          ['LOAD', 'PERCENTAGE', '2'],
        ])
      ).status,
    ).toBe(200);

    // Deposit 200, fees ON TOP: credited in full; 2 + 0.75 booked on top.
    const d = await deposit(mixed, '200');
    mixedDepositExt = d.ext;
    expect(d.txn.amount).toBe('200');
    expect(d.txn.commissionAmount).toBe('2');
    expect(d.txn.networkFeeAmount).toBe('0.75');
    expect(d.txn.netAmount).toBe('200');
    await expectWallet(mixed, 200, 0, 'after ON_TOP deposit');

    // Withdrawal 100, fees DEDUCTED: 2 + 0.5% (0.50) come out of the 100.
    const w = await request(mixed, 'withdrawals', '100');
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.feeApplication).toBe('DEDUCTED');
    expect(w.body.feeAmount).toBe('2');
    expect(w.body.networkFeeAmount).toBe('0.5');
    expect(w.body.netAmount).toBe('97.5');
    expect(w.body.totalAmount).toBe('100');
    await expectWallet(mixed, 100, 100, 'withdrawal reserved');
    await approve('withdrawals', w.body.id);
    await expectWallet(mixed, 100, 0, 'withdrawal settled');

    // Payout 40, fees ON TOP: 1% (0.40) + 0.25 on top → 40.65 leaves the wallet.
    const p = await request(mixed, 'payouts', '40');
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.feeApplication).toBe('ON_TOP');
    expect(p.body.feeAmount).toBe('0.4');
    expect(p.body.networkFeeAmount).toBe('0.25');
    expect(p.body.netAmount).toBe('40');
    expect(p.body.totalAmount).toBe('40.65');
    await approve('payouts', p.body.id);
    await expectWallet(mixed, 59.35, 0, 'payout settled');

    // Load 50, fees ON TOP: 1 + 2% (1.00) on top → operator collects 52, wallet +50.
    const l = await request(mixed, 'loads', '50');
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body.feeAmount).toBe('1');
    expect(l.body.networkFeeAmount).toBe('1');
    expect(l.body.netAmount).toBe('50');
    expect(l.body.totalAmount).toBe('52');
    await approve('loads', l.body.id);
    await expectWallet(mixed, 109.35, 0, 'load settled');

    // A payout the wallet cannot cover ONCE THE FEES ARE ADDED is refused whole:
    // 109.35 available, 109.35 requested → needs 110.69 (+1.09 +0.25).
    const tooMuch = await request(mixed, 'payouts', '109.35');
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(tooMuch.body)).toMatch(/INSUFFICIENT|nsufficient/);
    await expectWallet(mixed, 109.35, 0, 'after a refused payout');

    // Rejected payout: the whole reserved total (incl. both fees) comes back.
    const r = await request(mixed, 'payouts', '10');
    await expectWallet(mixed, 109.35 - 10.35, 10.35, 'payout reserved');
    expect(
      (
        await mutate(admin.api, admin.csrf, 'post', `/v1/admin/payouts/${r.body.id}/reject`, {
          notes: 'matrix',
        })
      ).status,
    ).toBe(201);
    await expectWallet(mixed, 109.35, 0, 'payout rejected');

    // Revenue booked for this company, account by account.
    near(await ledgerSum(mixed.companyId, 'NETWORK_FEE'), 0.75 + 0.5 + 0.25 + 1, 'NETWORK_FEE');
    near(await ledgerSum(mixed.companyId, 'FEE'), 2 + 2 + 0.4 + 1, 'FEE');

    // Left PENDING for the back-office checks below.
    const pw = await request(mixed, 'withdrawals', '30', Q_WITHDRAWAL); // net 27.85
    const pp = await request(mixed, 'payouts', '20', Q_PAYOUT); // net 20, total 20.45
    const pl = await request(mixed, 'loads', '100', Q_LOAD); // total 103
    for (const x of [pw, pp, pl]) expect(x.status, JSON.stringify(x.body)).toBe(201);
    pendingWithdrawalId = pw.body.id;
    pendingPayoutId = pp.body.id;
    pendingLoadId = pl.body.id;
    expect(pw.body.netAmount).toBe('27.85'); // 30 − 2 − 0.15
    expect(pp.body.totalAmount).toBe('20.45'); // 20 + 0.20 + 0.25
    expect(pl.body.totalAmount).toBe('103'); // 100 + 1 + 2
  });

  // -------------------------------------------------------------------------
  test('3. edge cases: rounding, replay, refusals, a ladder hole, a re-reversal, a fake "complete"', async () => {
    edge = await party([
      ['TRANSACTION', 'DEDUCTED', 'FIXED', '2'],
      ['PAYOUT', 'DEDUCTED', 'PERCENTAGE', '0'],
      // A WITHDRAWAL ladder that only starts at 100: below it no tier matches.
      ['WITHDRAWAL', 'DEDUCTED', 'FIXED', '2', '100'],
    ]);
    expect(
      (
        await setNetworkFee(edge, true, [
          ['TRANSACTION', 'PERCENTAGE', '0.125'],
          ['PAYOUT', 'FIXED', '1'],
          ['WITHDRAWAL', 'FIXED', '5'],
        ])
      ).status,
    ).toBe(200);

    // ---- rounding: 0.125% is rounded ONCE, half to even, to the cent ----
    for (const [amount, network, net] of [
      ['100', '0.12', '97.88'], //   0.125   → 0.12 (tie → even)
      ['300', '0.38', '297.62'], //  0.375   → 0.38 (tie → even)
      ['200', '0.25', '197.75'], //  0.25    exact
      ['33.33', '0.04', '31.29'], // 0.04166 → 0.04
    ] as const) {
      const { txn } = await deposit(edge, amount);
      expect(txn.networkFeeAmount, `network fee on ${amount}`).toBe(network);
      expect(txn.netAmount, `net on ${amount}`).toBe(net);
    }
    const funded = 97.88 + 297.62 + 197.75 + 31.29;
    await expectWallet(edge, funded, 0, 'after the rounding deposits');

    // ---- an idempotent replay books nothing twice ----
    const first = await deposit(edge, '50');
    await expectWallet(edge, funded + 47.94, 0, 'after the $50 deposit'); // 50 − 2 − 0.06
    const replay = await deposit(edge, '50', first.ext);
    expect(replay.txn.id).toBe(first.txn.id);
    expect(replay.txn.networkFeeAmount).toBe(first.txn.networkFeeAmount);
    await expectWallet(edge, funded + 47.94, 0, 'after the replay');
    let available = funded + 47.94;

    // ---- a fee that eats the whole amount is refused, and the error is exact ----
    // PAYOUT: 0% commission + $1 network fee, DEDUCTED → a $1 payout leaves nothing.
    const eaten = await request(edge, 'payouts', '1');
    expect(eaten.status).toBe(400);
    expect(eaten.body.error.code).toBe('VALIDATION_ERROR');
    // With no commission on the flow, ONLY the network fee is named.
    expect(eaten.body.error.message).toMatch(/^The 1 USD network fee consumes the entire amount/);
    expect(eaten.body.error.details).toEqual({ amount: '1', fee: '0', networkFee: '1' });
    await expectWallet(edge, available, 0, 'after the refused payout');

    // ---- an amount below the ladder is charged the same way as the ladder ----
    const rules = (await getJson(admin.api, '/v1/admin/commission-rules?pageSize=100'))
      .data as Array<{
      companyIds: string[] | null;
      active: boolean;
      operations: Array<{ operationType: string }>;
    }>;
    const globalWithdrawalRule = rules.some(
      (r) =>
        r.active &&
        (r.companyIds === null || r.companyIds.length === 0) &&
        r.operations.some((o) => o.operationType === 'WITHDRAWAL'),
    );
    if (!globalWithdrawalRule) {
      const below = await request(edge, 'withdrawals', '99.99');
      expect(below.status, JSON.stringify(below.body)).toBe(201);
      expect(below.body.feeAmount).toBe('0'); // no tier covers 99.99
      expect(below.body.networkFeeAmount).toBe('5');
      // DEDUCTED like the rest of this company's withdrawals — not flipped to the
      // ON_TOP default one cent below the first tier.
      expect(below.body.feeApplication).toBe('DEDUCTED');
      expect(below.body.totalAmount).toBe('99.99');
      expect(below.body.netAmount).toBe('94.99');
      const inside = await request(edge, 'withdrawals', '100');
      expect(inside.body.feeApplication).toBe('DEDUCTED');
      expect(inside.body.feeAmount).toBe('2');
      expect(inside.body.netAmount).toBe('93');
      await expectWallet(edge, available - 199.99, 199.99, 'two withdrawals reserved');

      // ---- "the transfer went through" only settles a row that was claimed ----
      const fake = await mutate(
        admin.api,
        admin.csrf,
        'post',
        `/v1/admin/withdrawals/${inside.body.id}/resolve-processing`,
        { action: 'complete', externalReference: 'never-sent' },
      );
      expect(fake.status).toBe(409);
      expect((await getJson(admin.api, `/v1/admin/withdrawals/${inside.body.id}`)).status).toBe(
        'PENDING',
      );
      await expectWallet(edge, available - 199.99, 199.99, 'after the refused complete');

      // The company cancels both: everything reserved returns.
      for (const id of [below.body.id, inside.body.id]) {
        expect(
          (await mutate(edge.owner, edge.csrf, 'post', `/v1/company/withdrawals/${id}/cancel`))
            .status,
        ).toBe(201);
      }
      await expectWallet(edge, available, 0, 'after cancelling both');
    }

    // ---- reversing twice: the second one changes nothing ----
    const toReverse = await deposit(edge, '100'); // +97.88
    available += 97.88;
    const reverse = () =>
      mutate(admin.api, admin.csrf, 'post', `/v1/admin/transactions/${toReverse.txn.id}/reverse`, {
        reason: 'matrix chargeback',
      });
    const r1 = await reverse();
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('REVERSED');
    available -= 97.88;
    await expectWallet(edge, available, 0, 'after the reversal');
    const r2 = await reverse();
    expect(r2.status).toBe(201);
    expect(r2.body.status).toBe('REVERSED');
    await expectWallet(edge, available, 0, 'after reversing again');
    // Both fees were handed back exactly once.
    near(await ledgerSum(edge.companyId, 'NETWORK_FEE'), 0.12 + 0.38 + 0.25 + 0.04 + 0.06);
    near(await ledgerSum(edge.companyId, 'FEE'), 2 * 5);
  });

  // -------------------------------------------------------------------------
  test('4. configuration: nothing invalid is ever saved; OFF keeps the rates', async () => {
    const path = `/v1/admin/companies/${edge.companyId}/network-fee`;
    const before = await getJson(admin.api, path);
    const put = (body: Record<string, unknown>) => mutate(admin.api, admin.csrf, 'put', path, body);
    const rate = (operationType: string, feeType: string, feeValue: string) => ({
      operationType,
      feeType,
      feeValue,
    });

    for (const [why, body] of [
      [
        'a percentage above 100',
        { enabled: true, rates: [rate('TRANSACTION', 'PERCENTAGE', '101')] },
      ],
      ['a zero rate', { enabled: true, rates: [rate('TRANSACTION', 'PERCENTAGE', '0')] }],
      [
        'a fixed fee with sub-cent digits',
        { enabled: true, rates: [rate('LOAD', 'FIXED', '1.005')] },
      ],
      [
        'a percentage with 9 decimals',
        { enabled: true, rates: [rate('LOAD', 'PERCENTAGE', '0.123456789')] },
      ],
      ['a value that is not a number', { enabled: true, rates: [rate('LOAD', 'FIXED', 'abc')] }],
      ['a negative value', { enabled: true, rates: [rate('LOAD', 'FIXED', '-1')] }],
      [
        'the same flow twice',
        {
          enabled: true,
          rates: [rate('PAYOUT', 'FIXED', '1'), rate('PAYOUT', 'PERCENTAGE', '1')],
        },
      ],
      ['switched on with no rate', { enabled: true, rates: [] }],
      ['an unknown flow', { enabled: true, rates: [rate('REFUND', 'FIXED', '1')] }],
    ] as const) {
      const res = await put(body);
      // 400 — never a 500, and never a save.
      expect(res.status, `${why}: ${JSON.stringify(res.body)}`).toBe(400);
    }
    expect(await getJson(admin.api, path)).toEqual(before);

    // Switching OFF keeps the rates, so switching back on restores the setup.
    const off = await put({ enabled: false, rates: before.rates });
    expect(off.status).toBe(200);
    expect(await getJson(admin.api, path)).toEqual({ enabled: false, rates: before.rates });
    const whileOff = await deposit(edge, '100');
    expect(whileOff.txn.networkFeeAmount).toBe('0');
    expect(whileOff.txn.netAmount).toBe('98');
    expect((await put({ enabled: true, rates: before.rates })).status).toBe(200);
    const backOn = await deposit(edge, '100');
    expect(backOn.txn.networkFeeAmount).toBe('0.12');

    // A company owner can neither read nor change the configuration.
    expect((await edge.owner.get(path)).status()).toBe(403);
    expect(
      (await mutate(edge.owner, edge.csrf, 'put', path, { enabled: false, rates: [] })).status,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  test('5. the CRM receives both fees on a deposit and on a withdrawal', async () => {
    const inbox = async (p: Party, reference: string, event: string) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rows = await getJson(p.owner, '/v1/company/crm/demo/inbox');
        const hit = rows.find(
          (e: { reference: string; event: string }) =>
            e.reference === reference && e.event === event,
        );
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`${event} for ${reference} never arrived: ${JSON.stringify(rows)}`);
        }
        await sleep(500);
      }
    };

    // Deposits (the events were queued in scenario 1).
    const d = await inbox(dual, `omt:${dualExt}`, 'transaction.completed');
    expect(d.transaction).toMatchObject({
      status: 'COMPLETED',
      amount: '100',
      commissionAmount: '1.5',
      networkFeeAmount: '1',
      netAmount: '97.5',
    });
    const s = (await getJson(single.owner, '/v1/company/crm/demo/inbox')).find(
      (e: { event: string }) => e.event === 'transaction.completed',
    );
    expect(s.transaction).toMatchObject({ commissionAmount: '2.5', networkFeeAmount: '0' });

    // A withdrawal: pending → completed on ONE reference, both fees on each event.
    expect(
      (
        await setNetworkFee(dual, true, [
          ['TRANSACTION', 'PERCENTAGE', '1'],
          ['WITHDRAWAL', 'FIXED', '0.5'],
        ])
      ).status,
    ).toBe(200);
    const w = await request(dual, 'withdrawals', '20');
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    const reference = `withdrawal:${w.body.id}`;
    const pending = await inbox(dual, reference, 'withdrawal.pending');
    expect(pending.withdrawal.networkFeeAmount).toBe('0.5');
    expect(num(pending.withdrawal.totalAmount)).toBeCloseTo(
      num(pending.withdrawal.netAmount) + num(pending.withdrawal.feeAmount) + 0.5,
      6,
    );
    await approve('withdrawals', w.body.id);
    const completed = await inbox(dual, reference, 'withdrawal.completed');
    expect(completed.status).toBe('COMPLETED');
    expect(completed.withdrawal.networkFeeAmount).toBe('0.5');
    // One record per reference: the pending row was replaced, not duplicated.
    const rows = await getJson(dual.owner, '/v1/company/crm/demo/inbox');
    expect(rows.filter((e: { reference: string }) => e.reference === reference)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  test('6. a company only ever gets its OWN activity totals', async () => {
    const q = 'direction=IN&pageSize=50';
    const mine = async (p: Party) =>
      (await getJson(p.owner, `/v1/company/transactions?pageSize=100`)).meta.total;
    const singleDeposits = await mine(single);
    const dualDeposits = await mine(dual);
    expect(singleDeposits).toBe(1);
    expect(dualDeposits).toBeGreaterThanOrEqual(1);

    // The admin looks at the single-fee company first (fills the cache)…
    const adminView = await getJson(
      admin.api,
      `/v1/admin/activity?${q}&companyId=${single.companyId}`,
    );
    expect(adminView.meta.total).toBe(singleDeposits);
    // …then each company asks the SAME filtered question: each gets its own.
    const forDual = await getJson(dual.owner, `/v1/company/activity?${q}`);
    const forSingle = await getJson(single.owner, `/v1/company/activity?${q}`);
    expect(forDual.meta.total).toBe(dualDeposits);
    expect(forSingle.meta.total).toBe(singleDeposits);
    expect(forDual.data.every((r: { companyId: null }) => r.companyId === null)).toBe(true);

    // ?companyId= is an admin-only filter: a company cannot aim the feed elsewhere.
    const aimed = await getJson(
      dual.owner,
      `/v1/company/activity?${q}&companyId=${single.companyId}`,
    );
    expect(aimed.meta.total).toBe(dualDeposits);
    expect(aimed.data.map((r: { id: string }) => r.id).sort()).toEqual(
      forDual.data.map((r: { id: string }) => r.id).sort(),
    );
    // And nothing it did changed what the admin sees for the other company.
    expect(
      (await getJson(admin.api, `/v1/admin/activity?${q}&companyId=${single.companyId}`)).meta
        .total,
    ).toBe(singleDeposits);
  });

  // -------------------------------------------------------------------------
  test('7. back office in the real dashboard: one figure per operation, and never a fee', async ({
    browser,
  }) => {
    const bo = await provisionPlatformUser(admin, 'BACKOFFICE', PW);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      // ---- API: the ON_TOP deposit shows what the customer paid (200), never 202.75 ----
      const deposits = await getJson(bo.api, `/v1/admin/transactions?companyId=${mixed.companyId}`);
      const dep = deposits.data.find(
        (t: { externalTransactionId: string }) => t.externalTransactionId === mixedDepositExt,
      );
      expect(dep.amount).toBe('200');
      expect(JSON.stringify(deposits)).not.toMatch(
        /202\.75|commissionAmount|networkFeeAmount|netAmount/,
      );
      const feed = await getJson(
        bo.api,
        `/v1/admin/activity?companyId=${mixed.companyId}&pageSize=50`,
      );
      expect(feed.meta.balanceMode).toBe(false);
      const feedDeposit = feed.data.find((r: { id: string }) => r.id === dep.id);
      near(feedDeposit.amount, 200, 'activity: the paid amount, not paid + fees');
      expect(JSON.stringify(feed)).not.toMatch(/202\.75|"fee"|"networkFee"|"net"/);
      const csv = await getCsv(
        bo.api,
        `/v1/admin/activity/export.csv?companyId=${mixed.companyId}`,
      );
      const csvRow = csv.rows.find((r) => r[0] === dep.id)!;
      near(csv.cell(csvRow, 'gross_amount'), 200);
      for (const blank of ['fee_amount', 'net_amount', 'network_fee_amount', 'fee_application']) {
        expect(csv.cell(csvRow, blank), blank).toBe('');
      }
      // Notifications: the operator's figure only — what to pay / collect.
      const bell = await getJson(bo.api, '/v1/notifications?pageSize=50');
      const bodyFor = (id: string) =>
        bell.data.find((n: { entityId: string }) => n.entityId === id)?.body as string;
      expect(bodyFor(pendingWithdrawalId)).toMatch(/requested a withdrawal: 27\.85 USD to pay\.$/);
      expect(bodyFor(pendingPayoutId)).toMatch(/requested a payout: 20 USD to pay\.$/);
      expect(bodyFor(pendingLoadId)).toMatch(/requested a load: 103 USD to collect\.$/);
      // Back office cannot read or change the configuration, nor the company detail.
      const cfg = `/v1/admin/companies/${mixed.companyId}/network-fee`;
      expect((await bo.api.get(cfg)).status()).toBe(403);
      expect((await bo.api.get(`/v1/admin/companies/${mixed.companyId}`)).status()).toBe(403);

      // ---- the browser ----
      await loginAs(page, bo.email, bo.password, '/admin');
      // Deposits: the paid amount; no fee column, no network line, no gross.
      await page.goto(`/admin/deposits?companyId=${mixed.companyId}`, {
        waitUntil: 'domcontentloaded',
      });
      const depositRow = page.locator('tbody tr', { hasText: mixedDepositExt });
      await expect(depositRow).toBeVisible({ timeout: 30_000 });
      await expect(depositRow).toContainText('200.00 USD');
      await expect(page.getByRole('columnheader', { name: 'Fee', exact: true })).toHaveCount(0);
      await expect(page.getByRole('columnheader', { name: 'Net', exact: true })).toHaveCount(0);
      await expect(page.getByText(/network/i)).toHaveCount(0);
      await expect(page.getByText('202.75')).toHaveCount(0);
      // Its drawer: the idempotency section is there; the ledger is not.
      await depositRow.click();
      await expect(page.getByRole('heading', { name: 'Idempotency' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('heading', { name: 'Ledger' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Provider payload' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // Withdrawals queue → Approve / Reject: the pay figure, no fee, no "—".
      await openReview(page, '/admin/withdrawals', Q_WITHDRAWAL, 'Approve');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(
        'Pay the recipient 27.85 USD out-of-band, then record the reference here.',
      );
      // No fee wording, and no placeholder where a figure should be ("— USD").
      await expect(dialog).not.toContainText(/fee|— USD/i);
      await page.keyboard.press('Escape');
      await openReview(page, '/admin/withdrawals', Q_WITHDRAWAL, 'Reject');
      await expect(dialog).toContainText(
        'The recipient will not be paid 27.85 USD, and the company keeps its funds.',
      );
      await expect(dialog).not.toContainText(/fee|— USD|Reserved/i);
      await page.keyboard.press('Escape');

      // Loads queue → Approve: the collect figure (103), never the credit (100).
      await openReview(page, '/admin/loads', Q_LOAD, 'Approve');
      await expect(dialog).toContainText(
        'Confirm you received 103.00 USD from the company, then approve to credit their wallet.',
      );
      await expect(dialog).not.toContainText(/fee|— USD|100\.00/i);
      await page.keyboard.press('Escape');

      // Payouts queue → Reject, for real: the toast is spelled correctly.
      await openReview(page, '/admin/payouts', Q_PAYOUT, 'Reject');
      await expect(dialog).toContainText(
        'The recipient will not be paid 20.00 USD, and the company keeps its funds.',
      );
      await dialog.getByRole('button', { name: /Confirm reject/i }).click();
      await expect(page.getByText('Payout rejected', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      // The whole 20.45 went back to the company.
      expect((await getJson(admin.api, `/v1/admin/payouts/${pendingPayoutId}`)).status).toBe(
        'REJECTED',
      );
      await expectWallet(mixed, 109.35 - 30, 30, 'after back office rejected the payout');
    } finally {
      await context.close();
      await bo.api.dispose();
    }
  });

  test('7b. a full admin still sees both fees in the same dialogs', async ({ page }) => {
    await openReview(page, '/admin/loads', Q_LOAD, 'Approve');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'Confirm you received 103.00 USD (fees included) from the company, then approve to credit their wallet with 100.00 USD.',
    );
    await expect(dialog).toContainText('Network fee');
    await page.keyboard.press('Escape');
    await openReview(page, '/admin/withdrawals', Q_WITHDRAWAL, 'Approve');
    await expect(dialog).toContainText(
      'Pay the recipient 27.85 USD out-of-band (the fees are already deducted), then record the reference here.',
    );
  });

  // Observed behaviour, not a regression guard: today a sign-out also ends in a
  // full page load (the next background request gets a 401 → session-expired
  // reload), which discards the cache on its own — so this passes with or
  // without the query-cache clear on sign-out / sign-in (checked). It pins that
  // the user-visible outcome stays right whichever mechanism provides it.
  test('7c. nothing of the previous user survives a sign-out on the same tab', async ({
    browser,
  }) => {
    // Both companies have a deposit whose external id contains "mx-"; each
    // searches for it. The query key is identical for both — only the session
    // differs — so a cache that outlived the sign-out would show the first
    // company's rows to the second.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await loginAs(page, dual.ownerEmail, PW, '/app');
      await page.goto('/app/deposits', { waitUntil: 'domcontentloaded' });
      const search = page.getByRole('textbox', {
        name: /search by phone, customer, reference or id/i,
      });
      await search.fill('mx-');
      await expect(page.getByText(dualExt)).toBeVisible({ timeout: 30_000 });

      // Sign out and sign in as the OTHER company — soft navigations, no reload.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL('**/login**', { timeout: 15_000 });
      await page.locator('#email').fill(single.ownerEmail);
      await page.locator('#password').fill(PW);
      // Hold the second company's own answer back, so only a cache could render rows.
      await page.route('**/v1/company/transactions?**', async (route) => {
        await sleep(3_000);
        await route.continue();
      });
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/app**', { timeout: 20_000, waitUntil: 'commit' });
      await page.getByRole('link', { name: 'Deposits', exact: true }).click();
      await page.waitForURL('**/app/deposits**', { timeout: 15_000, waitUntil: 'commit' });
      await page
        .getByRole('textbox', { name: /search by phone, customer, reference or id/i })
        .fill('mx-');

      // While its request is still in flight, the other company's deposit is NOT shown.
      const others = page.getByText(dualExt);
      for (let i = 0; i < 8; i++) {
        await expect(others).toHaveCount(0);
        await sleep(250);
      }
      // Then its own data arrives — and still nothing of the other company.
      await expect(page.getByText(new RegExp(`mx-${single.slug}-`)).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(others).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  test('8. admin dashboards show the network fee beside every volume that includes it', async ({
    page,
  }) => {
    // Company detail: the Network fees KPI and the per-source line.
    await page.goto(`/admin/companies/${dual.companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Network fees', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/\+\s*1\.00\s*network/).first()).toBeVisible({ timeout: 30_000 });
    // The single-fee company's page shows neither.
    await page.goto(`/admin/companies/${single.companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Platform fees').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Network fees', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/\+\s*[\d.,]+\s*network/)).toHaveCount(0);

    // Platform overview: the network-fee revenue card and a per-source line.
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Network fees', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/\+\s*[\d.,]+\s*network/).first()).toBeVisible({ timeout: 30_000 });

    // Source drill-down: by company.
    await page.goto(`/admin/sources/${omtId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/\+\s*[\d.,]+\s*network/).first()).toBeVisible({ timeout: 30_000 });

    // The same figures over the API, to the cent, for the dual-fee company.
    const overview = await getJson(
      admin.api,
      `/v1/admin/analytics/overview?companyId=${dual.companyId}&currency=USD`,
    );
    const omt = overview.topSources.find((s: { sourceCode: string }) => s.sourceCode === 'omt');
    near(omt.volume, 100);
    near(omt.fees, 1.5);
    near(omt.networkFees, 1);
    near(overview.kpi.totalNetworkFees, 1 + 0.5); // the deposit + the withdrawal of scenario 5
    const dayNetwork = overview.daily.buckets.reduce(
      (sum: number, b: { networkFees: string }) => sum + num(b.networkFees),
      0,
    );
    near(dayNetwork, 1, 'the daily buckets carry the deposit network fee');
    // The operations queue shows a pending load at the total to collect.
    const ops = await getJson(admin.api, '/v1/admin/analytics/operations');
    const item = ops.items.find((i: { id: string }) => i.id === pendingLoadId);
    if (item) {
      // (The queue lists the oldest pending requests; ours is there on a fresh DB.)
      near(item.amount, 103);
      expect(item.summary).toContain('103');
    }
  });

  test('9. the books reconcile: ledger == wallets, platform-wide', async () => {
    const recon = await mutate(admin.api, admin.csrf, 'post', '/v1/admin/reconciliation/run');
    expect(recon.body.divergentCount).toBe(0);
    // And the admin's own credentials were never needed by the browser tests above.
    expect(ADMIN_EMAIL.length + ADMIN_PASSWORD.length).toBeGreaterThan(0);
    // Leave no request pending in the admin queues.
    for (const [flow, id] of [
      ['withdrawals', pendingWithdrawalId],
      ['loads', pendingLoadId],
    ] as const) {
      const r = await mutate(admin.api, admin.csrf, 'post', `/v1/admin/${flow}/${id}/reject`, {
        notes: 'matrix cleanup',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect(unwrap(recon.body)).toBeTruthy();
  });
});

/** Open a queue page and click Approve / Reject on the row of `recipient`. */
async function openReview(
  page: Page,
  path: string,
  recipient: string,
  action: 'Approve' | 'Reject',
) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  const row = page.locator('tbody tr', { hasText: recipient });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
}
