// Resolve the IP to log for a request.
//
// pino-http hands the serializer the raw socket peer as `remoteAddress`. Behind
// the reverse proxy that is always the proxy container's own address, so every
// external caller collapses into one indistinguishable IP and the logs can't be
// used to trace who made a request. Express already resolves the real client
// from X-Forwarded-For (`trust proxy` in main.ts, honoured the same way by the
// throttler and the audit trail), so prefer that and fall back to the socket
// address for unproxied callers such as the container's local health probe.
export function clientIp(req: { raw?: unknown; remoteAddress?: string }): string | undefined {
  const forwarded = (req.raw as { ip?: string } | undefined)?.ip;
  return forwarded ?? req.remoteAddress;
}
