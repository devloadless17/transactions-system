import { ForbiddenError } from '../errors/domain.error';

/**
 * The REST API's CORS origin check. No `Origin` (server-to-server calls — API
 * keys, curl, health checks) or an allowlisted one goes through. Any other
 * origin is REFUSED server-side, not merely left without CORS headers, so a
 * page on another site cannot get a request handled at all.
 *
 * Refused as a 403 FORBIDDEN, logged as a warning like any other refused
 * request. It used to be a plain Error, which the exception filter can only
 * report as an unexpected 500 INTERNAL_ERROR at error level — so every stray
 * cross-site request (a bot, a scanner, a bookmark of a renamed host) looked
 * like an outage in the logs.
 */
export function corsOriginCheck(allowed: readonly string[]) {
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void): void => {
    if (!origin || allowed.includes(origin)) cb(null, true);
    else cb(new ForbiddenError(`Origin ${origin} not allowed`));
  };
}
