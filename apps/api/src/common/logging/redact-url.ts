// Strip secret-bearing values from a request URL before it is logged, so they
// never reach the logs / APM / proxy access logs: the Whish callback `token`
// (and any `secret`/`api_key`) query param, plus the CRM-demo path token
// (/crm-demo/<token>/inbox). The rest of the URL is preserved for debugging.
//
// Shared by the pino request serializer (logger.module.ts) and the global
// exception filter so both log paths redact identically.
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url
    .replace(/([?&](?:token|secret|api[-_]?key)=)[^&#]*/gi, '$1[redacted]')
    .replace(/(\/crm-demo\/)[^/?#]+/gi, '$1[redacted]');
}
