import { describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { diffFields, recordAuditChanges } from './audit-changes';

const req = () => ({}) as AuthenticatedRequest;

const ROW = {
  id: 'c1',
  name: 'Alpha',
  slug: 'alpha',
  status: 'ACTIVE',
  visible: true,
  webhookSecret: 'shhh',
};
const FIELDS = ['name', 'slug', 'status', 'visible'] as const;

describe('diffFields', () => {
  it('includes only fields the patch defines AND actually changes', () => {
    expect(diffFields(ROW, { name: 'Beta', slug: 'alpha' }, FIELDS)).toEqual({
      name: { from: 'Alpha', to: 'Beta' },
    });
  });

  it('returns an empty diff for a no-op patch', () => {
    expect(diffFields(ROW, { name: 'Alpha', visible: true }, FIELDS)).toEqual({});
    expect(diffFields(ROW, {}, FIELDS)).toEqual({});
  });

  it('handles booleans, including false', () => {
    expect(diffFields(ROW, { visible: false }, FIELDS)).toEqual({
      visible: { from: true, to: false },
    });
  });

  // The allowlist is the primary defence: `companies` carries webhookSecret /
  // crmApiKey / crmDemoToken on the same row as the fields worth auditing.
  it('ignores fields outside the allowlist even when the patch sets them', () => {
    const changes = diffFields(ROW, { name: 'Beta', webhookSecret: 'leaked' }, FIELDS);
    expect(Object.keys(changes)).toEqual(['name']);
  });
});

describe('recordAuditChanges', () => {
  it('merges contributions across calls', () => {
    const r = req();
    recordAuditChanges(r, { name: { from: 'Alpha', to: 'Beta' } });
    recordAuditChanges(r, { visible: { from: true, to: false } });
    expect(r.auditChanges).toEqual({
      name: { from: 'Alpha', to: 'Beta' },
      visible: { from: true, to: false },
    });
  });

  // Belt-and-braces: nothing should reach here, because the type is scalar-only
  // and producers pass an allowlist — but audit rows are ADMIN_OPERATOR-readable.
  it('drops sensitive-looking keys', () => {
    const r = req();
    recordAuditChanges(r, {
      name: { from: 'Alpha', to: 'Beta' },
      webhookSecret: { from: 'a', to: 'b' },
      crmApiKey: { from: 'a', to: 'b' },
      passwordHash: { from: 'a', to: 'b' },
      authToken: { from: 'a', to: 'b' },
    });
    expect(Object.keys(r.auditChanges ?? {})).toEqual(['name']);
  });

  it('truncates long values so one row cannot bloat the audit table', () => {
    const r = req();
    recordAuditChanges(r, { name: { from: 'a', to: 'x'.repeat(500) } });
    const to = r.auditChanges?.name.to as string;
    expect(to.length).toBe(201); // 200 chars + the ellipsis
    expect(to.endsWith('…')).toBe(true);
  });

  it('caps the number of fields', () => {
    const r = req();
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`f${i}`, { from: 0, to: 1 }]),
    );
    recordAuditChanges(r, many);
    expect(Object.keys(r.auditChanges ?? {})).toHaveLength(20);
  });
});
