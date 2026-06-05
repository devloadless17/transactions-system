import { SetMetadata } from '@nestjs/common';

/** Reflector key the ResponseEnvelopeInterceptor reads to know it must NOT wrap a route. */
export const SKIP_RESPONSE_ENVELOPE = 'skipResponseEnvelope';

/**
 * Opt a route (or whole controller) OUT of the global {success,statusCode,data}
 * response envelope. Use it for endpoints whose body is NOT our JSON API
 * contract: non-JSON producers (CSV exports), the health probe (its raw
 * {status,db} shape is what orchestrators/monitors read, and it sets its own
 * 503), and inbound provider acks where we are the RECEIVER and the caller only
 * keys off the HTTP status (Whish callback, the demo-CRM inbox).
 *
 * The interceptor already auto-skips 204/empty and non-object payloads, so this
 * is only needed where the handler returns a JSON object we still want left raw.
 */
export const SkipResponseEnvelope = () => SetMetadata(SKIP_RESPONSE_ENVELOPE, true);
