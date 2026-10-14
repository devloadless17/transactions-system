import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A deploy releases the API and the web, nothing else. Postgres, Redis and
 * Caddy are shared, stateful and outside blue/green: restarting one is an
 * outage. Compose restarts them on its own unless told not to — `docker
 * compose run migrate` brings migrate's dependency (Postgres) up to date
 * first, and RECREATED production Postgres on 2026-10-14, after a Compose
 * upgrade changed its config fingerprint (~2s without a database, mid-deploy).
 *
 * These pin every Compose call the deploy path makes. String checks on the
 * shipped files, so they run in the infra-free unit suite.
 */

// Resolve a repo file by walking up from the test runner's cwd (works whether
// invoked via `pnpm --filter @app/api test` or `pnpm -r test`).
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate ${rel} from cwd=${process.cwd()}`);
}

const DEPLOY_PATH = [
  '.github/workflows/deploy.yml',
  '.github/workflows/deploy-staging.yml',
  'scripts/deploy/release.sh',
  'rollback.sh',
];

// A Compose invocation as these files spell it: directly, through staging's
// `$SC`, or through release.sh's `"${COMPOSE[@]}"`.
const COMPOSE = /docker compose\b|\$SC\b|\$\{COMPOSE\[@\]\}/;
const INFRA = /(?<![\w-])(postgres|redis|caddy)(-staging)?(?![\w-])/;
const sub = (cmd: string, name: string) => new RegExp(`\\s${name}(\\s|$)`).test(cmd);

/** Every Compose command the deploy path runs (comments skipped). */
const calls = DEPLOY_PATH.flatMap((rel) =>
  fs
    .readFileSync(repoFile(rel), 'utf8')
    .split('\n')
    .map((line, i) => ({ where: `${rel}:${i + 1}`, cmd: line.trim() }))
    .filter(({ cmd }) => !cmd.startsWith('#') && COMPOSE.test(cmd)),
);
const ups = calls.filter((c) => sub(c.cmd, 'up'));
const runs = calls.filter((c) => sub(c.cmd, 'run'));
const infraUps = ups.filter((c) => INFRA.test(c.cmd));

describe('a deploy never restarts Postgres, Redis or Caddy', () => {
  it('sees the Compose calls it guards (a moved or renamed call fails here, not silently)', () => {
    // prod + staging: infra up; release.sh: API colour + web.
    expect(ups.length).toBeGreaterThanOrEqual(4);
    // prod + staging migrations.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(infraUps.length).toBe(2);
  });

  it('every `up` and `run` passes --no-deps: Compose never brings a dependency up to date', () => {
    const missing = [...ups, ...runs].filter((c) => !c.cmd.includes('--no-deps'));
    expect(missing).toEqual([]);
  });

  it('infra is only started if missing: never recreated', () => {
    const recreating = infraUps.filter(
      (c) => !c.cmd.includes('--no-recreate') || c.cmd.includes('--force-recreate'),
    );
    expect(recreating).toEqual([]);
  });

  it('the migrations run against a healthy database: the infra `up` waits for it', () => {
    // `run --no-deps migrate` skips migrate's depends_on (service_healthy), so
    // the step before it has to give that order instead.
    expect(infraUps.filter((c) => !c.cmd.includes('--wait'))).toEqual([]);
  });

  it('infra is never pulled, stopped, removed or torn down by a deploy', () => {
    const touching = calls.filter(
      (c) =>
        (INFRA.test(c.cmd) && /\s(pull|stop|restart|rm|kill|down|create)(\s|$)/.test(c.cmd)) ||
        /\sdown(\s|$)|--remove-orphans/.test(c.cmd),
    );
    expect(touching).toEqual([]);
  });
});
