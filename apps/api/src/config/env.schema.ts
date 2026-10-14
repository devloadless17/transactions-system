import { z } from 'zod';

/**
 * The ONLY host that serves live Whish money. Everything else — the legacy
 * sandbox (api.sandbox.whish.money), the v1.4.4 sandbox
 * (partner.api.sbx.whish.money), a future rename, a local fake, a typo — is a
 * non-production upstream.
 */
export const WHISH_PROD_HOST = 'api.whish.money';

/**
 * True only for the live Whish API base. Deliberately an ALLOWLIST, not a
 * blacklist: the previous guard matched the substring 'sandbox', which the
 * v1.4.4 sandbox host (`partner.api.sbx.whish.money`) slips past — a production
 * build could then boot pointed at the sandbox, mint sandbox links for real
 * customers and collect nothing. Matching the one known-live host instead means
 * any future rename fails CLOSED.
 *
 * - hostname equality, so `api.whish.money.evil.com` / `notapi.whish.money` fail
 * - case-insensitive (URL already lowercases, belt-and-braces)
 * - https only: an http base would put the `secret:` header on the wire in clear
 * - unparseable input ⇒ not live ⇒ fail closed
 */
export function isLiveWhishBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      u.hostname.toLowerCase() === WHISH_PROD_HOST &&
      (u.port === '' || u.port === '443')
    );
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    API_HOST: z.string().default('0.0.0.0'),
    API_GLOBAL_PREFIX: z.string().default('v1'),

    DATABASE_URL: z.string().min(1),

    REDIS_URL: z.string().default('redis://localhost:6379'),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 3600),

    // Keys the stateless double-submit CSRF token (HMAC-SHA256 over a random
    // nonce). Rotating it invalidates every outstanding token, forcing a single
    // CSRF refresh on the next mutating request. Must differ from the JWT
    // secrets so one leaked secret doesn't compromise both auth and CSRF.
    CSRF_SECRET: z.string().min(32),

    // Leave EMPTY for host-only auth cookies (no Domain attribute) — the
    // recommended setup for our same-origin web+API. Host-only keeps each
    // host's cookies to itself, so a prod cookie can't bleed into a staging
    // subdomain. Only set an explicit domain if you deliberately need cookies
    // shared across subdomains (we don't).
    COOKIE_DOMAIN: z.string().default('localhost'),
    COOKIE_SECURE: z
      .union([z.literal('true'), z.literal('false')])
      .default('false')
      .transform((v) => v === 'true'),

    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

    // The API's own externally reachable base URL, including the global prefix
    // (e.g. https://api.example.com/v1). Used to build the built-in CRM demo
    // inbox URL so a company can preview the integration end-to-end.
    API_PUBLIC_URL: z.string().url().default('http://localhost:3001/v1'),

    RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

    // ---- Source-ingest limiters ----
    // Authenticated ingest volume per API key, per minute. 0 (the default) =
    // UNLIMITED, and that is deliberate: a source pushing deposits is pushing
    // money that ALREADY left the payer, so throttling it can only strand real
    // funds. Set a positive value to rein in one misbehaving partner — tunable
    // from the server env, no deploy needed.
    INGEST_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(0),

    // Company Whish Pay API (/v1/integrations/whish/*), per API key, per
    // minute: creating a payment link, and refreshing a status from Whish — each
    // with its OWN counter (a CRM polling with refresh can never use up its link
    // creation). Never a ceiling for real customers — a company's customers must
    // never be refused the start of a deposit, and Whish puts no limit on our
    // account — only a last-resort BRAKE against a flood (a leaked key, a broken
    // integration stuck in a loop), refused before any database or Whish work.
    // 60,000 = 1,000 a second for a whole minute: more than the platform itself
    // serves, so the platform's capacity is reached first and real customers
    // are never refused by it. 0 disables.
    // (No per-IP cap on these endpoints: key guessing is limited separately, per
    // failed attempt — AUTH_FAILURE_MAX_PER_MIN.)
    // A NEW name on purpose: staging's hand-kept env file still carries the
    // retired INTEGRATION_RATE_LIMIT_MAX=300 (the old combined cap, copied from
    // the old example), and that line must never cap link creation again — so
    // the old name is not read anywhere (docs-contract.spec.ts pins it).
    INTEGRATION_CREATE_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(60000),

    // Status LOOKUPS on the Whish Pay API (GET /v1/integrations/whish/payments/
    // :reference), per API key, per minute — their own counter. A lookup only
    // reads our database (no Whish call); CRMs poll each link a few times while
    // the customer pays (~4 per link in production), so this brake sits 5x
    // higher: 300,000 = 5,000 a second. 0 disables.
    INTEGRATION_LOOKUP_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300000),

    // FAILED API-key authentications per (client IP, key prefix), per minute
    // (5x that per IP across prefixes). Always on, for every API key — source
    // keys on ingest and company keys on the Whish Pay API and /v1/company/*:
    // this is the surface an attacker actually hammers (key guessing, plus
    // argon2 CPU burn once a valid 8-char key prefix is known). A working key
    // never counts toward it, so real partners can never trip it.
    AUTH_FAILURE_MAX_PER_MIN: z.coerce.number().int().positive().default(20),

    // When set, GET /metrics requires `Authorization: Bearer <token>`. Empty in
    // dev (open); set it in production so the metrics aren't world-readable.
    METRICS_TOKEN: z.string().default(''),

    // ---- Whish Pay integration (single platform account) ----
    // Sandbox base by default (Whish Pay v1.4.4 moved it to partner.api.sbx…);
    // flip to https://api.whish.money/itel-service/api for production.
    // `channel` + `secret` are issued by Whish. Trailing slashes are trimmed
    // because WhishClient concatenates `${base}${path}` — a stray slash would
    // produce `…/api//payment/whish`.
    WHISH_BASE_URL: z
      .string()
      .url()
      .default('https://partner.api.sbx.whish.money/itel-service/api')
      .transform((v) => v.replace(/\/+$/, '')),
    WHISH_CHANNEL: z.string().default(''),
    WHISH_SECRET: z.string().default(''),
    WHISH_WEBSITE_URL: z.string().default('http://localhost:3000'),
    WHISH_USER_AGENT: z.string().default('Whish/1.0 (https://whish.money; support@whish.money)'),
    // Public base URL Whish will call back to (the API's externally reachable
    // origin, including the global prefix), e.g. https://api.example.com/v1
    WHISH_CALLBACK_BASE: z.string().url().default('http://localhost:3001/v1'),
    // Which currencies are live for Whish links. USD only for now; to enable
    // LBP, set `USD,LBP` AND configure commission rules covering LBP amounts.
    WHISH_ENABLED_CURRENCIES: z
      .string()
      .default('USD')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    // Escape hatch for testing the Whish *sandbox* against a production build:
    // when "true", the prod guards stop rejecting the sandbox base URL and a
    // non-https website URL (e.g. the sandbox's "rival.com"). Everything else
    // (callback must be a public https host, no localhost) still applies. Leave
    // false/unset for a live deploy.
    WHISH_ALLOW_SANDBOX: z
      .union([z.literal('true'), z.literal('false')])
      .default('false')
      .transform((v) => v === 'true'),

    // ---- Whish W2W (consumer-app) transfers ----
    // A DIFFERENT Whish surface from the merchant collect API above: the
    // consumer mobile-app endpoint (POST {base}/application/submit) used to send
    // whish-to-whish transfers. The session creds (token/uid/sessionid/…) are a
    // captured logged-in app session that EXPIRES, so they live in an encrypted,
    // admin-editable DB row — NOT here. Only the non-secret base/flags + the
    // encryption key live in env.
    WHISH_W2W_ENABLED: z
      .union([z.literal('true'), z.literal('false')])
      .default('false')
      .transform((v) => v === 'true'),
    WHISH_W2W_BASE_URL: z.string().url().default('https://api.whish.money/itel-service'),
    // AES-256-GCM key (base64 of 32 bytes) that encrypts the session creds at
    // rest. Required when W2W is enabled. Generate: `openssl rand -base64 32`.
    WHISH_W2W_ENC_KEY: z.string().default(''),
    // Static non-secret headers Whish expects on the consumer-app call.
    WHISH_W2W_LANGUAGE: z.string().default('en'),
    WHISH_W2W_TIMEZONE: z.string().default('Asia/Beirut'),
    WHISH_W2W_THEME: z.string().default('light'),
    // Staging-only: run the withdrawal auto-approval pipeline WITHOUT moving
    // money — the poller keeps every gate and rule (admin toggle, hold window,
    // WISH/USD, cap) but fabricates a SUCCESS instead of calling the W2W send,
    // stamping a `SIMULATED-` reference. W2W has NO sandbox, so this is the only
    // safe way to exercise auto-approval outside production. Mutually exclusive
    // with WHISH_W2W_ENABLED (enforced below); only docker-compose.staging.yml
    // passes it through, so a prod deploy can never enable it.
    WITHDRAWAL_AUTO_APPROVAL_SIMULATE: z
      .union([z.literal('true'), z.literal('false')])
      .default('false')
      .transform((v) => v === 'true'),

    // ---- Telegram alerts (load/payout requests) ----
    // Best-effort push to a platform-admin Telegram group the moment a company
    // submits a load/payout request (never withdrawals). BOTH must be set for
    // the feature to fire — leave BOTH blank to disable it (the default, and how
    // staging stays silent while shipping identical code to production).
    // `TELEGRAM_BOT_TOKEN` comes from @BotFather; `TELEGRAM_CHAT_ID` is the group
    // id (a negative number, e.g. -100… for supergroups) — kept as a string.
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_CHAT_ID: z.string().default(''),
  })
  // Telegram alerts are all-or-nothing: a half-configured pair (token without a
  // chat id, or vice versa) would silently never deliver. Fail closed so a typo
  // surfaces at boot rather than as a missed money request. Applies in every
  // environment (dev leaves both blank → passes), so it sits before the
  // production-only guard below.
  .superRefine((env, ctx) => {
    const hasToken = env.TELEGRAM_BOT_TOKEN.trim().length > 0;
    const hasChat = env.TELEGRAM_CHAT_ID.trim().length > 0;
    if (hasToken !== hasChat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasToken ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN'],
        message:
          'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together (or both left blank)',
      });
    }
  })
  // Simulated auto-approval and real W2W transfers must never coexist: with
  // both on, an operator could read "auto-approved" as "money sent" (or the
  // reverse). Fail closed at boot, in EVERY environment — staging runs with
  // NODE_ENV=production, so this cannot live behind the production-only guard.
  .superRefine((env, ctx) => {
    if (env.WITHDRAWAL_AUTO_APPROVAL_SIMULATE && env.WHISH_W2W_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WITHDRAWAL_AUTO_APPROVAL_SIMULATE'],
        message:
          'must not be enabled together with WHISH_W2W_ENABLED — simulated approvals and real W2W transfers are mutually exclusive',
      });
    }
  })
  // Fail closed in production: the dev-friendly defaults above (insecure
  // cookies, the committed "change_me" secrets, http origins) must never reach
  // a real deployment. Anyone who reads the repo could otherwise forge a
  // SUPER_ADMIN JWT or read cookies off a plaintext hop.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (!env.COOKIE_SECURE) {
      fail('COOKIE_SECURE', 'must be "true" in production (auth cookies are HTTPS-only)');
    }
    if (env.COOKIE_DOMAIN === 'localhost') {
      fail('COOKIE_DOMAIN', 'must not be "localhost" in production');
    }
    if (!env.WEB_ORIGIN.startsWith('https://')) {
      fail('WEB_ORIGIN', 'must use https in production');
    }
    const origins = env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const insecureOrigins = origins.filter((o) => !o.startsWith('https://'));
    if (insecureOrigins.length > 0) {
      fail(
        'ALLOWED_ORIGINS',
        `all origins must use https in production (got: ${insecureOrigins.join(', ')})`,
      );
    }
    // An empty/incomplete CORS allowlist is a foot-gun: the real web app is
    // blocked while credentialed no-Origin requests still pass. Fail closed.
    if (origins.length === 0) {
      fail('ALLOWED_ORIGINS', 'must be a non-empty https origin list in production');
    } else if (!origins.includes(env.WEB_ORIGIN)) {
      fail('ALLOWED_ORIGINS', 'must include WEB_ORIGIN in production');
    }

    // /metrics leaks operational + tenant-topology data; require the bearer gate.
    if (!env.METRICS_TOKEN) {
      fail('METRICS_TOKEN', 'must be set in production (else GET /metrics is world-readable)');
    }

    // Never run a real-money deploy against the committed dev/default DB
    // passwords (the runtime RLS role + superuser ship with public defaults).
    if (
      /txn_app_dev_password|txn_app_rls_dev_password|dev_password|change[_-]?me/i.test(
        env.DATABASE_URL,
      )
    ) {
      fail(
        'DATABASE_URL',
        'must not use a dev/default database password in production — rotate the txn_app_rls role password',
      );
    }

    const looksLikeDevSecret = (s: string) =>
      /change[_-]?me|dev[_-]?(access|refresh|secret|csrf)/i.test(s);
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CSRF_SECRET'] as const) {
      if (looksLikeDevSecret(env[key])) {
        fail(key, 'must not use a dev/default secret in production');
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      fail('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
    }
    if (env.CSRF_SECRET === env.JWT_ACCESS_SECRET || env.CSRF_SECRET === env.JWT_REFRESH_SECRET) {
      fail('CSRF_SECRET', 'must differ from the JWT secrets');
    }

    // When Whish is wired up (channel/secret set), the dev defaults — the sandbox
    // API base and a localhost callback — would silently mean "wrong environment /
    // no live callbacks reach us". Fail closed so a misconfigured prod can't run
    // collecting real money it can never settle automatically.
    if (env.WHISH_CHANNEL || env.WHISH_SECRET) {
      if (!env.WHISH_CALLBACK_BASE.startsWith('https://')) {
        fail('WHISH_CALLBACK_BASE', 'must use https in production');
      }
      if (/localhost|127\.0\.0\.1/.test(env.WHISH_CALLBACK_BASE)) {
        fail(
          'WHISH_CALLBACK_BASE',
          'must be a publicly reachable host in production, not localhost',
        );
      }
      // WHISH_ALLOW_SANDBOX is the explicit opt-in for running a NON-PRODUCTION
      // Whish upstream against a prod build while testing — it relaxes ONLY the
      // live-base and website-https checks below; the callback must still be a
      // public https host.
      if (!env.WHISH_ALLOW_SANDBOX && !isLiveWhishBaseUrl(env.WHISH_BASE_URL)) {
        fail(
          'WHISH_BASE_URL',
          `must be the live Whish API (https://${WHISH_PROD_HOST}/itel-service/api) in production — got '${env.WHISH_BASE_URL}'. ` +
            'Set WHISH_ALLOW_SANDBOX=true to run a non-production Whish upstream (e.g. the sandbox) against a production build.',
        );
      }
      // WHISH_WEBSITE_URL is an auth header Whish matches against the registered
      // domain — a stale localhost value makes every Whish call fail auth at
      // runtime (and it is NOT otherwise validated). The sandbox registers a bare
      // host (e.g. "rival.com"), so we only require https when not in sandbox mode;
      // localhost is always rejected.
      const websiteIsLocal = /localhost|127\.0\.0\.1/.test(env.WHISH_WEBSITE_URL);
      if (
        websiteIsLocal ||
        (!env.WHISH_ALLOW_SANDBOX && !env.WHISH_WEBSITE_URL.startsWith('https://'))
      ) {
        fail(
          'WHISH_WEBSITE_URL',
          'must be your registered https domain in production (not localhost)',
        );
      }
    }

    // W2W transfers move real money out of the platform's Whish account. When
    // enabled, fail closed unless the upstream is a public https host and the
    // at-rest encryption key for the session creds is present (a missing/short
    // key would otherwise leave the captured session unencrypted or unreadable).
    if (env.WHISH_W2W_ENABLED) {
      if (!env.WHISH_W2W_BASE_URL.startsWith('https://')) {
        fail('WHISH_W2W_BASE_URL', 'must use https in production');
      }
      if (/localhost|127\.0\.0\.1/.test(env.WHISH_W2W_BASE_URL)) {
        fail('WHISH_W2W_BASE_URL', 'must be a publicly reachable host, not localhost');
      }
      // 32 raw bytes, base64-encoded, is 44 chars; require at least that.
      if (env.WHISH_W2W_ENC_KEY.trim().length < 44) {
        fail(
          'WHISH_W2W_ENC_KEY',
          'must be set to a base64 32-byte key when WHISH_W2W_ENABLED (run: openssl rand -base64 32)',
        );
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
