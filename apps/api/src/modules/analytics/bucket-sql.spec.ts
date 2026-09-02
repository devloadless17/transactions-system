import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The bucket width is chosen by the server, but it still reaches Postgres as a
 * BOUND parameter rather than being interpolated into the SQL string. These
 * assertions read the services' source so the property is pinned structurally:
 * a future "simplification" that inlines the unit back into the template fails
 * here rather than in review.
 *
 * The `AT TIME ZONE 'UTC'` cast is pinned for a different reason. The columns
 * are timestamptz, so date_trunc would otherwise resolve in the Postgres
 * session TimeZone — which this repo never pins. On a non-UTC server every
 * week/month bucket would shift against the UTC gap-fillers and come back
 * empty. Applying it to only SOME queries would be worse than none, because the
 * fee overlay would land in a different bucket from the bars it annotates.
 */
const SERVICES = ['analytics.service.ts', 'platform-analytics.service.ts'] as const;

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe.each(SERVICES)('%s bucketing SQL', (file) => {
  const src = read(file);
  const truncCalls = src.match(/date_trunc\([^)]*\)/g) ?? [];

  it('has bucketed queries at all (guards against a silent refactor)', () => {
    expect(truncCalls.length).toBeGreaterThan(0);
  });

  it('never interpolates the unit as a literal', () => {
    for (const call of truncCalls) {
      expect(call).not.toMatch(/date_trunc\('(day|week|month)'/);
      // A JS template hole would mean the unit is built into the string.
      expect(call).not.toMatch(/date_trunc\(\$\{/);
    }
  });

  // The PARAMETER INDEX may be computed (`$${truncParam}` resolves to $4 or $5
  // depending on an optional company filter) — that is a number the server
  // derives. What must never be interpolated is the UNIT itself.
  it('binds the unit as a parameter on every bucketed query', () => {
    for (const call of truncCalls) {
      expect(call).toMatch(/date_trunc\(\$(\d+|\$\{truncParam\})::text/);
    }
  });

  it("truncates AT TIME ZONE 'UTC' on every bucketed query", () => {
    for (const call of truncCalls) {
      expect(call).toMatch(/AT TIME ZONE 'UTC'/);
    }
  });

  it('routes the unit through the whitelist helper', () => {
    expect(src).toMatch(/sqlTruncUnit\(/);
  });
});
