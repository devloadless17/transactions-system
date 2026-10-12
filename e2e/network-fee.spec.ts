import { test, expect } from '@playwright/test';
import {
  adminApiContext,
  cashRequest,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  mutate,
  num,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

/**
 * The optional per-company network fee through the REAL running stack
 * (HTTP → Nest → Postgres RLS):
 *
 *  - A SUPER_ADMIN configures it (audited); validation refuses a switch-on with
 *    no rate; an ADMIN_OPERATOR can read it but never change it.
 *  - The tech lead's example end to end: a $100 deposit with a $2 commission and
 *    a 1% network fee credits $97 — and the SOURCE never sees any fee.
 *  - A withdrawal carries both fees ON_TOP and the wallet reserves exactly the
 *    total; after approval the ledger still reconciles with zero discrepancies.
 *  - A company with the switch OFF is unaffected ("0" everywhere).
 */

const NEW_PASSWORD = 'newpass-123';
const money = num;
const cashBody = cashRequest;
const send = mutate;

test.describe('network fee', () => {
  test('configure → deposit → withdrawal, with the off-company control', async () => {
    const admin = await adminApiContext();
    const co = await provisionCompanyOwner(admin);
    const off = await provisionCompanyOwner(admin);
    const sourceId = await findSourceId(admin.api, 'omt');
    await enableSourceForCompany(admin.api, admin.csrf, sourceId, co.companyId);
    await enableSourceForCompany(admin.api, admin.csrf, sourceId, off.companyId);
    const key = await createSourceKey(admin.api, admin.csrf, sourceId, `e2e-nf-${Date.now()}`);
    for (const companyId of [co.companyId, off.companyId]) {
      await createCommissionRule(admin.api, admin.csrf, {
        companyId,
        operationType: 'TRANSACTION',
        feeApplication: 'DEDUCTED',
        minAmount: '0',
        maxAmount: null,
        commissionType: 'FIXED',
        commissionValue: '2',
      });
    }
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: co.companyId,
      operationType: 'WITHDRAWAL',
      feeApplication: 'ON_TOP',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'FIXED',
      commissionValue: '2',
    });

    // ---- configuration (SUPER_ADMIN) ----
    const path = `/v1/admin/companies/${co.companyId}/network-fee`;
    const initial = unwrap(await (await admin.api.get(path)).json());
    expect(initial).toEqual({ enabled: false, rates: [] });

    const refused = await send(admin.api, admin.csrf, 'put', path, { enabled: true, rates: [] });
    expect(refused.status).toBe(400);

    const saved = await send(admin.api, admin.csrf, 'put', path, {
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.enabled).toBe(true);

    // The company detail resource carries it; the change is audited with a diff.
    const detail = unwrap(
      await (await admin.api.get(`/v1/admin/companies/${co.companyId}`)).json(),
    );
    expect(detail.networkFee.rates).toHaveLength(2);
    const audit = unwrap(
      await (
        await admin.api.get(
          `/v1/admin/audit-logs?companyId=${co.companyId}&action=company.network_fee_updated`,
        )
      ).json(),
    );
    const row = audit.data[0];
    expect(row.metadata.changes.networkFeeEnabled).toEqual({ from: false, to: true });
    expect(row.metadata.changes['networkFee.TRANSACTION']).toEqual({
      from: null,
      to: 'PERCENTAGE 1',
    });

    // ---- ADMIN_OPERATOR: may read, may never change ----
    const opEmail = `e2e-operator-${Date.now().toString(36)}@example.com`;
    const created = await send(admin.api, admin.csrf, 'post', '/v1/admin/users', {
      email: opEmail,
      role: 'ADMIN_OPERATOR',
    });
    expect(created.status).toBe(201);
    const operator = await loginOwnerApiContext(
      opEmail,
      created.body.temporaryPassword,
      NEW_PASSWORD,
    );
    try {
      expect((await operator.get(path)).status()).toBe(200);
      const denied = await send(operator, await getCsrf(operator), 'put', path, {
        enabled: false,
        rates: [],
      });
      expect(denied.status).toBe(403);
    } finally {
      await operator.dispose();
    }

    // ---- deposit: $100, $2 commission, 1% network fee ----
    const ext = `e2e-nf-${Date.now()}`;
    const ingest = await ingestTransaction('omt', key, {
      companySlug: co.slug,
      externalTransactionId: ext,
      amount: '100',
      currency: 'USD',
    });
    expect(ingest.status).toBe(201);
    // The source never sees what the company is charged.
    for (const hidden of ['commissionAmount', 'networkFeeAmount', 'netAmount']) {
      expect(ingest.body).not.toHaveProperty(hidden);
    }

    const owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, NEW_PASSWORD);
    try {
      const list = unwrap(await (await owner.get('/v1/company/transactions')).json()).data;
      const txn = list.find(
        (t: { externalTransactionId: string }) => t.externalTransactionId === ext,
      );
      expect(txn.commissionAmount).toBe('2');
      expect(txn.networkFeeAmount).toBe('1');
      expect(txn.netAmount).toBe('97');

      // ---- withdrawal: 50 ON_TOP → 53 debited, recipient gets 50 ----
      const csrf = await getCsrf(owner);
      const w = await send(owner, csrf, 'post', '/v1/company/withdrawals', cashBody('50'));
      expect(w.status).toBe(201);
      expect(w.body.feeAmount).toBe('2');
      expect(w.body.networkFeeAmount).toBe('1');
      expect(w.body.netAmount).toBe('50');
      expect(w.body.totalAmount).toBe('53');
      const wallets = unwrap(await (await owner.get('/v1/company/wallets')).json()).data;
      const usd = wallets.find((x: { currency: string }) => x.currency === 'USD');
      expect(money(usd.availableBalance)).toBeCloseTo(44, 6); // 97 − 53
      expect(money(usd.reservedBalance)).toBeCloseTo(53, 6);

      const approved = await send(
        admin.api,
        admin.csrf,
        'post',
        `/v1/admin/withdrawals/${w.body.id}/approve`,
        { externalReference: 'e2e-paid' },
      );
      expect(approved.status).toBe(201);
      expect(approved.body.status).toBe('COMPLETED');

      // The ledger still reconciles with the wallets, platform-wide.
      const recon = await send(admin.api, admin.csrf, 'post', '/v1/admin/reconciliation/run', {});
      expect(recon.body.divergentCount).toBe(0);
    } finally {
      await owner.dispose();
    }

    // ---- control: a company with the switch OFF pays no network fee ----
    const offExt = `e2e-nf-off-${Date.now()}`;
    expect(
      (
        await ingestTransaction('omt', key, {
          companySlug: off.slug,
          externalTransactionId: offExt,
          amount: '100',
          currency: 'USD',
        })
      ).status,
    ).toBe(201);
    const offOwner = await loginOwnerApiContext(off.ownerEmail, off.tempPassword, NEW_PASSWORD);
    try {
      const list = unwrap(await (await offOwner.get('/v1/company/transactions')).json()).data;
      const txn = list.find(
        (t: { externalTransactionId: string }) => t.externalTransactionId === offExt,
      );
      expect(txn.networkFeeAmount).toBe('0');
      expect(txn.netAmount).toBe('98');
    } finally {
      await offOwner.dispose();
      await admin.api.dispose();
    }
  });
});

/**
 * Back office never learns what the platform charges — enforced by the API,
 * not just the dashboard. A back-office session reads every endpoint it can
 * reach for a company charged BOTH fees; no response may carry a fee field or a
 * second money figure a fee could be derived from, and every CSV leaves those
 * cells blank.
 */
test('back office receives no fee — anywhere', async () => {
  const admin = await adminApiContext();
  const co = await provisionCompanyOwner(admin);
  const sourceId = await findSourceId(admin.api, 'omt');
  await enableSourceForCompany(admin.api, admin.csrf, sourceId, co.companyId);
  const key = await createSourceKey(admin.api, admin.csrf, sourceId, `e2e-bo-${Date.now()}`);
  await createCommissionRule(admin.api, admin.csrf, {
    companyId: co.companyId,
    operationType: 'TRANSACTION',
    feeApplication: 'DEDUCTED',
    minAmount: '0',
    maxAmount: null,
    commissionType: 'FIXED',
    commissionValue: '2',
  });
  const put = await send(
    admin.api,
    admin.csrf,
    'put',
    `/v1/admin/companies/${co.companyId}/network-fee`,
    {
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
      ],
    },
  );
  expect(put.status).toBe(200);
  const ext = `e2e-bo-${Date.now()}`;
  expect(
    (
      await ingestTransaction('omt', key, {
        companySlug: co.slug,
        externalTransactionId: ext,
        amount: '100',
        currency: 'USD',
      })
    ).status,
  ).toBe(201);
  const owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, NEW_PASSWORD);
  const w = await send(
    owner,
    await getCsrf(owner),
    'post',
    '/v1/company/withdrawals',
    cashBody('50'),
  );
  expect(w.status).toBe(201);
  await owner.dispose();

  const boEmail = `e2e-bo-${Date.now().toString(36)}@example.com`;
  const created = await send(admin.api, admin.csrf, 'post', '/v1/admin/users', {
    email: boEmail,
    role: 'BACKOFFICE',
  });
  expect(created.status).toBe(201);
  const bo = await loginOwnerApiContext(boEmail, created.body.temporaryPassword, NEW_PASSWORD);

  const FORBIDDEN = [
    'commissionAmount',
    'feeAmount',
    'networkFeeAmount',
    'fee',
    'networkFee',
    'feeApplication',
    'roundingRemainder',
  ];
  const scan = (v: unknown, path: string, found: string[]) => {
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`, found));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN.includes(k)) found.push(`${path}.${k}`);
        scan(x, `${path}.${k}`, found);
      }
    }
  };
  const getJson = async (path: string) => unwrap(await (await bo.get(path)).json());
  try {
    const deposits = await getJson(`/v1/admin/transactions?companyId=${co.companyId}`);
    const dep = deposits.data.find(
      (t: { externalTransactionId: string }) => t.externalTransactionId === ext,
    );
    expect(dep.amount).toBe('100'); // what the customer paid
    expect(dep).not.toHaveProperty('netAmount');
    const detail = await getJson(`/v1/admin/transactions/${dep.id}/detail`);
    expect(detail.ledgerEntries).toEqual([]);
    const wd = await getJson(`/v1/admin/withdrawals/${w.body.id}`);
    expect(wd.netAmount).toBe('50'); // what the recipient is paid
    expect(wd).not.toHaveProperty('totalAmount');
    const activity = await getJson(`/v1/admin/activity?companyId=${co.companyId}`);
    expect(activity.meta.balanceMode).toBe(false);

    const found: string[] = [];
    for (const [name, body] of Object.entries({
      deposits,
      detail,
      single: await getJson(`/v1/admin/transactions/${dep.id}`),
      withdrawals: await getJson(`/v1/admin/withdrawals?companyId=${co.companyId}`),
      wd,
      payouts: await getJson('/v1/admin/payouts'),
      loads: await getJson('/v1/admin/loads'),
      activity,
    }))
      scan(body, name, found);
    expect(found).toEqual([]);

    // CSV exports: the fee columns exist (stable positions) but are empty.
    for (const [path, blank] of [
      [
        '/v1/admin/transactions/export.csv',
        ['commission_amount', 'net_amount', 'network_fee_amount'],
      ],
      [
        '/v1/admin/withdrawals/export.csv',
        ['gross_amount', 'fee_amount', 'network_fee_amount', 'fee_application'],
      ],
      ['/v1/admin/activity/export.csv', ['fee_amount', 'network_fee_amount', 'fee_application']],
    ] as const) {
      const lines = (await (await bo.get(path)).text())
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\n');
      const header = lines[0]!.split(',');
      for (const line of lines.slice(1, 50)) {
        const cells = line.split(',');
        if (cells.length !== header.length) continue; // a free-text cell held a comma
        for (const col of blank) expect(cells[header.indexOf(col)], `${path} ${col}`).toBe('');
      }
    }
  } finally {
    await bo.dispose();
    await admin.api.dispose();
  }
});
