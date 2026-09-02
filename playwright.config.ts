import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Load repo-root .env so the e2e suite picks up the same admin credentials the
// DB seed uses (SEED_ADMIN_PASSWORD), keeping Playwright workers in sync with
// the seeded admin without fragile inline env vars. Each worker re-imports this
// config, so the load happens per-worker. A missing .env (CI injects env
// directly) is fine — we fall through to the defaults below.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env present — rely on the ambient environment */
}

// Port follows the same `WEB_PORT` knob as docker-compose and the web dev script,
// so a machine that moved the app off :3000 (a second project owning that port)
// runs the suite without per-invocation env vars. E2E_BASE_URL still wins.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3000'}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // Dev-mode flakiness: when the shared-package tsc watcher rebuilds, Nest
  // hot-reloads and may briefly drop connections. One retry handles this.
  retries: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],
});
