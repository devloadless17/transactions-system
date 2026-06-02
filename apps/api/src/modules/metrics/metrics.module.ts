import { Global, Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsInterceptor } from './metrics.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';

/**
 * Exposes /metrics in Prometheus exposition format. Includes:
 *   - default Node.js process metrics (memory, event loop lag, GC)
 *   - http_requests_total       — labeled by method/route/status
 *   - http_request_duration_seconds — histogram of request latency
 *   - txn_ingest_total          — counter incremented inside the ingestion service
 *
 * Marked @Global so typed metric providers can be injected anywhere
 * without each consumer module having to import MetricsModule.
 */
const metricProviders = [
  makeCounterProvider({
    name: 'http_requests_total',
    help: 'Total HTTP requests by route and status',
    labelNames: ['method', 'route', 'status'],
  }),
  makeHistogramProvider({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
  makeCounterProvider({
    name: 'txn_ingest_total',
    help: 'Transactions ingested (successful)',
    labelNames: ['source_code', 'currency'],
  }),
  makeGaugeProvider({
    name: 'ledger_wallet_divergent',
    help: 'Number of (company,currency) wallets whose balance diverges from the ledger as of the last reconciliation run',
  }),
  makeGaugeProvider({
    name: 'ledger_receivable_outstanding',
    help: 'Total outstanding RECEIVABLE (company debt to the platform) as of the last reconciliation run, by currency',
    labelNames: ['currency'],
  }),
];

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
      path: '/metrics',
      defaultLabels: { service: 'txn-api' },
    }),
  ],
  providers: [...metricProviders, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
  exports: metricProviders,
})
export class MetricsModule {}
