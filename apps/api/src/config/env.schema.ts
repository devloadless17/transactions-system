import { z } from 'zod';

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

    // When set, GET /metrics requires `Authorization: Bearer <token>`. Empty in
    // dev (open); set it in production so the metrics aren't world-readable.
    METRICS_TOKEN: z.string().default(''),

    // ---- Whish Pay integration (single platform account) ----
    // Sandbox base by default; flip to https://api.whish.money/itel-service/api
    // for production. `channel` + `secret` are issued by Whish.
    WHISH_BASE_URL: z.string().url().default('https://api.sandbox.whish.money/itel-service/api'),
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
      /change[_-]?me|dev[_-]?(access|refresh|secret)/i.test(s);
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (looksLikeDevSecret(env[key])) {
        fail(key, 'must not use a dev/default secret in production');
      }
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      fail('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
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
      // WHISH_ALLOW_SANDBOX is the explicit opt-in for running the Whish sandbox
      // against a prod build while testing — it relaxes ONLY the sandbox-base and
      // website-https checks below; the callback must still be a public https host.
      if (!env.WHISH_ALLOW_SANDBOX && env.WHISH_BASE_URL.includes('sandbox')) {
        fail(
          'WHISH_BASE_URL',
          'must not point at the Whish sandbox in production (set WHISH_ALLOW_SANDBOX=true to test the sandbox on prod)',
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
