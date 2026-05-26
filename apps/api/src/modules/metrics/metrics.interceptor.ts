import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Histogram } from 'prom-client';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Records request counters + duration histograms. Uses the route's
 * matched path (e.g. /admin/companies/:id) so that high-cardinality
 * actual URLs don't blow up the label cardinality.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_requests_total') private readonly reqCounter: Counter<string>,
    @InjectMetric('http_request_duration_seconds')
    private readonly reqHistogram: Histogram<string>,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap({
        next: () => this.record(req, res, start, res.statusCode || 200),
        error: () => this.record(req, res, start, res.statusCode || 500),
      }),
    );
  }

  private record(req: Request, res: Response, start: bigint, status: number) {
    const route = req.route?.path ?? '<unmatched>';
    const labels = { method: req.method, route, status: String(status) };
    this.reqCounter.inc(labels);
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    this.reqHistogram.observe(labels, seconds);
  }
}
