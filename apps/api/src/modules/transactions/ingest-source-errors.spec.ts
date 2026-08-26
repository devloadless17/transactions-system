import { describe, expect, it } from 'vitest';
import { DomainError, ValidationError } from '../../common/errors/domain.error';
import {
  CommissionExceedsAmountError,
  NoMatchingCommissionRuleError,
} from '../commissions/commission-resolver.service';
import { toSourceFacingError } from './ingest.controller';

/**
 * The source boundary must never leak our commission model: internal
 * pricing-config failures carry commission-named codes and details with
 * internal UUIDs / fee figures. They are translated to one neutral 422
 * (ENTITY_NOT_READY) whose details hold ONLY the caller's own companySlug.
 * Everything else passes through untouched.
 */
describe('toSourceFacingError — pricing errors never cross the source boundary', () => {
  const SLUG = 'acme-retail';

  it('NO_COMMISSION_RULE → neutral ENTITY_NOT_READY 422 with only the slug', () => {
    const internal = new NoMatchingCommissionRuleError(
      'b1c2d3e4-f5a6-4789-9abc-def012345678',
      '0a9b8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d',
      '10',
    );
    const out = toSourceFacingError(internal, SLUG) as DomainError;

    expect(out).toBeInstanceOf(DomainError);
    expect(out.code).toBe('ENTITY_NOT_READY');
    expect(out.httpStatus).toBe(422);
    expect(out.details).toEqual({ companySlug: SLUG });
    // Neither the message nor the details may carry internal identifiers,
    // commission wording, or the original code.
    const wire = JSON.stringify({ message: out.message, details: out.details });
    expect(wire).not.toMatch(/commission/i);
    expect(wire).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('COMMISSION_EXCEEDS_AMOUNT → the same neutral 422 (no rule id, no fee figures)', () => {
    const internal = new CommissionExceedsAmountError(
      '606ba9d9-6713-48b9-adb2-d0e8827146ca',
      '1',
      '3',
    );
    const out = toSourceFacingError(internal, SLUG) as DomainError;

    expect(out.code).toBe('ENTITY_NOT_READY');
    expect(out.httpStatus).toBe(422);
    expect(out.details).toEqual({ companySlug: SLUG });
  });

  it('any other DomainError passes through as the SAME instance', () => {
    const validation = new ValidationError('amount must be positive');
    expect(toSourceFacingError(validation, SLUG)).toBe(validation);
  });

  it('non-domain errors pass through untouched', () => {
    const boom = new Error('boom');
    expect(toSourceFacingError(boom, SLUG)).toBe(boom);
    expect(toSourceFacingError('weird', SLUG)).toBe('weird');
  });
});
