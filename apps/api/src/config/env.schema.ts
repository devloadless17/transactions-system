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

    COOKIE_DOMAIN: z.string().default('localhost'),
    COOKIE_SECURE: z
      .union([z.literal('true'), z.literal('false')])
      .default('false')
      .transform((v) => v === 'true'),
    CSRF_SECRET: z.string().min(32),

    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

    RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

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
    const insecureOrigins = env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .filter((o) => !o.startsWith('https://'));
    if (insecureOrigins.length > 0) {
      fail(
        'ALLOWED_ORIGINS',
        `all origins must use https in production (got: ${insecureOrigins.join(', ')})`,
      );
    }

    const looksLikeDevSecret = (s: string) =>
      /change[_-]?me|dev[_-]?(access|refresh|secret)/i.test(s);
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
