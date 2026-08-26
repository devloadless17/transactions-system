import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  adminApiContext,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

// Regression for the note-overwrite bug: a company's request note and the
// admin's action note (approval note / rejection reason) must coexist. The
// admin note used to overwrite the single `notes` column, destroying the
// company's. They now live in `notes` (company) and `adminNotes` (admin).

const NEW_PASSWORD = 'newpass-123';
const COMPANY_NOTE = 'COMPANY-ORIGINAL-please-keep-me';

async function seedWithCompanyNote(admin: { api: APIRequestContext; csrf: string }) {
  const { companyId, ownerEmail, tempPassword, slug } = await provisionCompanyOwner(admin);
  const omtId = await findSourceId(admin.api, 'omt');
  await enableSourceForCompany(admin.api, admin.csrf, omtId, companyId);
  const key = await createSourceKey(admin.api, admin.csrf, omtId, `acn-${Date.now()}`);
  const ingest = await ingestTransaction('omt', key, {
    companySlug: slug,
    externalTransactionId: `acn-${Date.now()}`,
    amount: '100',
    currency: 'USD',
  });
  expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);

  const owner = await loginOwnerApiContext(ownerEmail, tempPassword, NEW_PASSWORD);
  const csrf = await getCsrf(owner);
  const create = await owner.post('/v1/company/withdrawals', {
    headers: { 'x-csrf-token': csrf },
    data: {
      amount: '20',
      currency: 'USD',
      notes: COMPANY_NOTE,
      payout: { method: 'CASH', recipientName: 'Notes Test', recipientPhone: '+9613000999' },
    },
  });
  expect(create.ok(), `create: ${create.status()} ${await create.text()}`).toBe(true);
  const id = (unwrap(await create.json()) as { id: string }).id;
  return { owner, id };
}

test.describe('company note vs admin note', () => {
  test.setTimeout(120_000);

  test('rejecting keeps the company note AND records the admin reason separately', async () => {
    const admin = await adminApiContext();
    const { owner, id } = await seedWithCompanyNote(admin);

    const reason = `ADMIN-REJECT-REASON-${Date.now()}`;
    const reject = await admin.api.post(`/v1/admin/withdrawals/${id}/reject`, {
      headers: { 'x-csrf-token': admin.csrf },
      data: { notes: reason },
    });
    expect(reject.ok(), `reject: ${reject.status()} ${await reject.text()}`).toBe(true);

    const res = await admin.api.get(`/v1/admin/withdrawals/${id}`);
    const w = unwrap(await res.json()) as {
      status: string;
      notes: string | null;
      adminNotes: string | null;
    };
    expect(w.status).toBe('REJECTED');
    // The company's original note survived…
    expect(w.notes).toBe(COMPANY_NOTE);
    // …and the admin's reason is recorded separately.
    expect(w.adminNotes).toBe(reason);

    // The company sees the same separation through its own endpoint.
    const cres = await owner.get(`/v1/company/withdrawals/${id}`);
    const cw = unwrap(await cres.json()) as { notes: string | null; adminNotes: string | null };
    expect(cw.notes).toBe(COMPANY_NOTE);
    expect(cw.adminNotes).toBe(reason);

    await owner.dispose();
    await admin.api.dispose();
  });

  test('approving keeps the company note AND records the admin note separately', async () => {
    const admin = await adminApiContext();
    const { owner, id } = await seedWithCompanyNote(admin);

    const adminNote = `ADMIN-APPROVE-NOTE-${Date.now()}`;
    const approve = await admin.api.post(`/v1/admin/withdrawals/${id}/approve`, {
      headers: { 'x-csrf-token': admin.csrf },
      data: { externalReference: `REF-${Date.now()}`, notes: adminNote },
    });
    expect(approve.ok(), `approve: ${approve.status()} ${await approve.text()}`).toBe(true);

    const res = await admin.api.get(`/v1/admin/withdrawals/${id}`);
    const w = unwrap(await res.json()) as {
      status: string;
      notes: string | null;
      adminNotes: string | null;
    };
    expect(w.status).toBe('COMPLETED');
    expect(w.notes).toBe(COMPANY_NOTE);
    expect(w.adminNotes).toBe(adminNote);

    await owner.dispose();
    await admin.api.dispose();
  });
});
