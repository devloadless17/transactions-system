import { describe, expect, it, vi } from 'vitest';
import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';
import { SKIP_RESPONSE_ENVELOPE } from '../decorators/skip-response-envelope.decorator';

/**
 * Build a fake ExecutionContext + CallHandler. `reflect` controls what the
 * Reflector returns: `skip` for the SKIP_RESPONSE_ENVELOPE flag and `httpCode`
 * for the @HttpCode metadata.
 */
function setup(opts: {
  method?: string;
  resStatus?: number;
  contentType?: string;
  skip?: boolean;
  httpCode?: number;
  handlerValue: unknown;
}) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(opts.skip ?? undefined);
  vi.spyOn(reflector, 'get').mockImplementation((key: unknown) =>
    key === HTTP_CODE_METADATA ? opts.httpCode : undefined,
  );

  const res = {
    statusCode: opts.resStatus ?? 200,
    getHeader: (name: string) =>
      name.toLowerCase() === 'content-type' ? opts.contentType : undefined,
  };
  const req = { method: opts.method ?? 'GET' };

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;

  const next: CallHandler = { handle: () => of(opts.handlerValue) };

  const interceptor = new ResponseEnvelopeInterceptor(reflector);
  return { interceptor, context, next };
}

async function run(opts: Parameters<typeof setup>[0]) {
  const { interceptor, context, next } = setup(opts);
  return lastValueFrom(interceptor.intercept(context, next));
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps a plain object response (GET → 200)', async () => {
    const out = await run({ handlerValue: { id: 'abc', name: 'X' } });
    expect(out).toEqual({ success: true, statusCode: 200, data: { id: 'abc', name: 'X' } });
  });

  it('derives 201 for POST without @HttpCode', async () => {
    const out = await run({ method: 'POST', handlerValue: { id: 'new' } });
    expect(out).toEqual({ success: true, statusCode: 201, data: { id: 'new' } });
  });

  it('honours an explicit @HttpCode over the method default (POST @HttpCode(200))', async () => {
    const out = await run({ method: 'POST', httpCode: 200, handlerValue: { ok: true } });
    expect(out).toEqual({ success: true, statusCode: 200, data: { ok: true } });
  });

  it('wraps arrays/paginated payloads as data (array lives at data.data for lists)', async () => {
    const payload = { data: [{ id: 1 }], meta: { total: 1 } };
    const out = await run({ handlerValue: payload });
    expect(out).toEqual({ success: true, statusCode: 200, data: payload });
  });

  it('skips when @SkipResponseEnvelope() is set', async () => {
    const raw = { status: 'ok', db: 'ok' };
    const out = await run({ skip: true, handlerValue: raw });
    expect(out).toBe(raw);
  });

  it('skips empty/void bodies (204 / undefined / null)', async () => {
    expect(await run({ handlerValue: undefined })).toBeUndefined();
    expect(await run({ handlerValue: null })).toBeNull();
    expect(await run({ resStatus: 204, handlerValue: undefined })).toBeUndefined();
  });

  it('skips non-JSON payloads (string CSV / Buffer / StreamableFile)', async () => {
    const csv = 'a,b\n1,2';
    expect(await run({ handlerValue: csv })).toBe(csv);
    const buf = Buffer.from('x');
    expect(await run({ handlerValue: buf })).toBe(buf);
    const file = new StreamableFile(Buffer.from('x'));
    expect(await run({ handlerValue: file })).toBe(file);
  });

  it('skips when a non-JSON Content-Type was already set (text/csv)', async () => {
    const raw = { not: 'wrapped' };
    const out = await run({ contentType: 'text/csv; charset=utf-8', handlerValue: raw });
    expect(out).toBe(raw);
  });
});
