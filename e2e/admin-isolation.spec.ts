import { test, expect } from '@playwright/test';
import { provisionCompanyOwner, loginOwnerApiContext, unwrap } from './helpers';

/**
 * Admin-only / internal money surfaces must be unreachable from a COMPANY session.
 * The platform's net revenue, per-source fee breakdown, and a source's fee schedule
 * (what the source charges THE PLATFORM) are system-internal — a company must never
 * see them. This proves the role guard at the HTTP layer: a real company-owner
 * session gets 403, not data.
 */
test.describe('admin-only surfaces are unreachable from a company session', () => {
  test('company owner is forbidden from net-revenue, source-fee breakdown, and fee schedules', async () => {
    const { ownerEmail, tempPassword } = await provisionCompanyOwner();
    const owner = await loginOwnerApiContext(ownerEmail, tempPassword, 'newpass-iso-12345');
    try {
      // Platform analytics carries net revenue + the per-source fee breakdown.
      const platform = await owner.get('/v1/admin/analytics/platform');
      expect(platform.status(), 'net revenue / source-fee breakdown must be admin-only').toBe(403);

      // The source catalog is intentionally readable by any authenticated user
      // (companies need it to interpret transactions) — grab a source id from it.
      const cat = await owner.get('/v1/admin/sources/all');
      expect(cat.ok()).toBeTruthy();
      const sources = unwrap(await cat.json()).data as Array<{ id: string }>;
      const sourceId = sources[0]?.id;
      expect(sourceId, 'expected at least one seeded source').toBeTruthy();

      // …but a source's FEE SCHEDULE (cost it charges the platform) is admin-only.
      const read = await owner.get(`/v1/admin/sources/${sourceId}/fee-rules`);
      expect(read.status(), 'reading source fee schedule must be admin-only').toBe(403);

      const csrf = (await owner.storageState()).cookies.find((c) => c.name === 'csrf-token')?.value;
      const write = await owner.put(`/v1/admin/sources/${sourceId}/fee-rules`, {
        headers: { 'x-csrf-token': csrf ?? '' },
        data: { rules: [] },
      });
      expect(write.status(), 'writing source fee schedule must be admin-only').toBe(403);
    } finally {
      await owner.dispose();
    }
  });
});
