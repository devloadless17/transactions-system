import type { ExecutionContext } from '@nestjs/common';
import { HealthController } from '../../modules/health/health.controller';

/**
 * Requests the global per-IP throttler never counts:
 *
 * - Everything, when THROTTLE_DISABLED=true — the e2e suite only (a serial run
 *   does dozens of real logins); prod and staging never set it.
 * - A health check made from INSIDE our network: Caddy's active checks, the
 *   container's own healthcheck, the release script. Those carry no
 *   X-Forwarded-For, while Caddy adds one to every request it forwards — so a
 *   visitor's /v1/health always has it and stays limited like any other call.
 *
 * Throttling the internal checks was a trap, found in a blue/green rehearsal:
 * Caddy checks every second, per upstream name, all from its one IP. Past the
 * per-minute limit the check got a 429, Caddy concluded the API was down and
 * HELD every request until the window reset — ~16s, once a minute.
 */
export function skipThrottle(context: ExecutionContext): boolean {
  if (process.env.THROTTLE_DISABLED === 'true') return true;
  if (context.getType() !== 'http') return false;
  if (context.getClass() !== HealthController) return false;
  const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
  return req.headers['x-forwarded-for'] === undefined;
}
