import { describe, expect, it } from 'vitest';
import { auditChangesOf } from './audit';
import { companyNameSchema } from './company';

describe('companyNameSchema', () => {
  it('trims before validating, so a padded name is stored clean', () => {
    expect(companyNameSchema.parse('  Acme Corp  ')).toBe('Acme Corp');
    // ' a ' trims to one char and must fail, not pass on its padded length.
    expect(companyNameSchema.safeParse(' a ').success).toBe(false);
  });

  it('enforces 2–120 characters', () => {
    expect(companyNameSchema.safeParse('A').success).toBe(false);
    expect(companyNameSchema.safeParse('Ab').success).toBe(true);
    expect(companyNameSchema.safeParse('x'.repeat(120)).success).toBe(true);
    expect(companyNameSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });

  // Unlike the slug there is no charset restriction — a display name may carry
  // punctuation, accents or non-Latin script.
  it('accepts any characters', () => {
    for (const name of ['Acme & Co.', 'Société Générale', 'شركة الاختبار', '株式会社テスト']) {
      expect(companyNameSchema.safeParse(name).success).toBe(true);
    }
  });
});

describe('auditChangesOf', () => {
  it('returns the change map when present', () => {
    expect(auditChangesOf({ changes: { name: { from: 'A', to: 'B' } } })).toEqual({
      name: { from: 'A', to: 'B' },
    });
  });

  it('returns null for rows with no diff (every row written before this existed)', () => {
    expect(auditChangesOf(null)).toBeNull();
    expect(auditChangesOf(undefined)).toBeNull();
    expect(auditChangesOf({ method: 'PATCH', outcome: 'success' })).toBeNull();
    expect(auditChangesOf({ changes: {} })).toBeNull();
  });

  // The scalar union is what stops an entity row — which on `companies` sits
  // beside webhookSecret / crmApiKey — from being renderable as a diff.
  it('rejects non-scalar values rather than rendering them', () => {
    expect(auditChangesOf({ changes: { name: { from: { secret: 1 }, to: 'B' } } })).toBeNull();
    expect(auditChangesOf({ changes: { name: 'not-a-change' } })).toBeNull();
  });

  it('accepts every scalar kind, including false and null', () => {
    expect(
      auditChangesOf({
        changes: { visible: { from: true, to: false }, note: { from: null, to: 'x' } },
      }),
    ).toEqual({ visible: { from: true, to: false }, note: { from: null, to: 'x' } });
  });
});
