import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { type ZodError, z } from 'zod';
import type { ApiErrorEnvelope } from '@app/shared';
import { GlobalExceptionFilter } from './global-exception.filter';
import { NotFoundError, ValidationError } from '../errors/domain.error';

function capture(exception: unknown): { status: number; body: ApiErrorEnvelope } {
  const json = vi.fn((_body: unknown) => undefined);
  const status = vi.fn((_code: number) => ({ json }));
  const res = { status };
  const req = { method: 'GET', originalUrl: '/v1/x' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  new GlobalExceptionFilter().catch(exception, host);
  return {
    status: status.mock.calls[0]![0],
    body: json.mock.calls[0]![0] as ApiErrorEnvelope,
  };
}

describe('GlobalExceptionFilter envelope', () => {
  it('wraps a DomainError as { success:false, statusCode, error }', () => {
    const { status, body } = capture(new ValidationError('bad amount', { field: 'amount' }));
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      statusCode: 400,
      error: { code: 'VALIDATION_ERROR', message: 'bad amount', details: { field: 'amount' } },
    });
  });

  it('sets the HTTP status from the domain error (NotFound → 404)', () => {
    const { status, body } = capture(new NotFoundError('transaction', 'abc'));
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps a ZodError to a 400 VALIDATION_ERROR envelope', () => {
    let zerr: ZodError;
    try {
      z.object({ a: z.string() }).parse({ a: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      zerr = e as ZodError;
    }
    const { status, body } = capture(zerr);
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('maps a Nest HttpException, keeping its status', () => {
    const { status, body } = capture(new BadRequestException('nope'));
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('falls back to 500 INTERNAL_ERROR for an unknown throw, leaking nothing', () => {
    const { status, body } = capture(new Error('db on fire with secret connection string'));
    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      statusCode: 500,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
});

describe('numeric overflow (SQLSTATE 22003) maps to a clean 400', () => {
  it('translates a Prisma unknown ConnectorError carrying 22003 instead of leaking a 500', async () => {
    const { Prisma } = await import('@app/db');
    const overflow = new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError(PostgresError { code: "22003", message: "numeric field overflow" })',
      { clientVersion: '0.0.0' },
    );
    const { status, body } = capture(overflow);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('A monetary value exceeds the supported range');
    // No internals leak (no SQLSTATE, table, or Prisma wording in the envelope).
    expect(JSON.stringify(body)).not.toMatch(/22003|Prisma|Connector/i);
  });
});

describe('22003 matching is anchored (no substring false positives)', () => {
  it('does NOT remap an unknown error that merely CONTAINS the digits 22003', async () => {
    const { Prisma } = await import('@app/db');
    const lookalike = new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError(QueryError { message: "duplicate reference INV-22003 on connection 122003" })',
      { clientVersion: '0.0.0' },
    );
    const { status, body } = capture(lookalike);
    // A transient/unknown DB fault must stay a 500 (retryable per the docs),
    // never a permanent-looking 400.
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('transient Prisma faults stay retryable 5xx', () => {
  it.each(['P2024', 'P2028'])(
    '%s (pool/transaction timeout) maps to 500 INTERNAL_ERROR, never a do-not-retry 400',
    async (code) => {
      const { Prisma } = await import('@app/db');
      const err = new Prisma.PrismaClientKnownRequestError('timeout', {
        code,
        clientVersion: '0.0.0',
      });
      const { status, body } = capture(err);
      expect(status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    },
  );
});
