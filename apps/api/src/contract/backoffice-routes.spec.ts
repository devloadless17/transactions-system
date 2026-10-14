import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Back-office route tripwire.
 *
 * BACKOFFICE must never learn what the platform charges (common/
 * backoffice-view.ts). The views there are fail-closed, but a view only helps
 * on a route that APPLIES it — and a new `@Roles(..., BACKOFFICE)` handler that
 * returns money rows without one would leak every fee with no failing test.
 *
 * So the set of routes back office can reach is pinned here, each with HOW it
 * stays fee-free. Adding a route to back office fails this test until it is
 * listed — which is the moment to decide its treatment:
 *   'view'     — returns money rows through a back-office view / CSV allow-list;
 *   'action'   — a mutation whose response goes through a back-office view;
 *   'no-money' — returns nothing a fee could be read or derived from.
 *
 * No infra needed: it parses the controllers' decorators.
 */

type Treatment = 'view' | 'action' | 'no-money';

const BACKOFFICE_ROUTES: Record<string, Treatment> = {
  // Unified activity feed
  'GET admin/activity': 'view',
  'GET admin/activity/export.csv': 'view',
  'GET admin/operations/counts': 'no-money',
  // Stuck-money alert: counts and dates only
  'GET admin/operations/attention': 'no-money',
  // Company picker (CompanyResponse carries no pricing)
  'GET admin/companies': 'no-money',
  // Deposits
  'GET admin/transactions': 'view',
  'GET admin/transactions/:id': 'view',
  'GET admin/transactions/:id/detail': 'view',
  'GET admin/transactions/export.csv': 'view',
  // Withdrawals
  'GET admin/withdrawals': 'view',
  'GET admin/withdrawals/:id': 'view',
  'GET admin/withdrawals/export.csv': 'view',
  'POST admin/withdrawals/:id/approve': 'action',
  'POST admin/withdrawals/:id/reject': 'action',
  // Payouts
  'GET admin/payouts': 'view',
  'GET admin/payouts/:id': 'view',
  'GET admin/payouts/export.csv': 'view',
  'POST admin/payouts/:id/approve': 'action',
  'POST admin/payouts/:id/reject': 'action',
  // Loads
  'GET admin/loads': 'view',
  'GET admin/loads/:id': 'view',
  'GET admin/loads/export.csv': 'view',
  'POST admin/loads/:id/approve': 'action',
  'POST admin/loads/:id/reject': 'action',
  // Whish collect links (the paid amount; the settlement reason is replaced)
  'GET admin/whish/balance': 'no-money',
  'GET admin/whish/payments': 'view',
  'GET admin/whish/payments/:id': 'view',
  'GET admin/whish/payments/export.csv': 'view',
  // The bell (a "new request" text is rebuilt from data for back office)
  'GET notifications': 'view',
  'POST notifications/:id/read': 'no-money',
  'POST notifications/:id/dismiss': 'no-money',
  'POST notifications/read-all': 'no-money',
  'POST notifications/clear-all': 'no-money',
};

/**
 * Handlers with NO `@Roles` at all: public, or open to ANY signed-in role —
 * back office included. Pinned for the same reason: a new one must be looked at.
 */
const UNGATED_ROUTES = [
  // Active source catalog (name/code/status only; metadata stripped).
  'GET admin/sources/all',
  'GET auth/csrf',
  'GET auth/me',
  'POST auth/change-password',
  'POST auth/login',
  'POST auth/logout',
  'POST auth/refresh',
  'GET health',
  // Authenticated by a source API key / a company API key / a signed token —
  // never by a dashboard session, so no dashboard role reaches them.
  'GET ingest/companies',
  'POST ingest/:sourceCode/transactions',
  'GET integrations/whish/payments/:reference',
  'POST integrations/whish/payments',
  'POST integrations/whish/payments/:reference/refresh',
  'POST crm-demo/:token/inbox',
  'GET whish/callback/failure',
  'GET whish/callback/success',
];

interface Handler {
  route: string;
  file: string;
  method: string;
  /** The effective `@Roles(...)` argument text, or null when ungated. */
  roles: string | null;
}

function srcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'apps/api/src');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate apps/api/src from cwd=${process.cwd()}`);
}

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(full);
    return e.name.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Every route handler of one controller file, with its effective roles. */
export function handlersOf(source: string, file: string): Handler[] {
  // `const ALL = [UserRole.A, ...]` lists spread into @Roles(...ALL).
  const lists = new Map<string, string>();
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g)) lists.set(m[1]!, m[2]!);
  const expand = (roles: string): string =>
    roles.replace(/\.\.\.(\w+)/g, (whole, name: string) => lists.get(name) ?? whole);

  const classAt = source.indexOf('export class');
  if (classAt < 0) return [];
  const head = source.slice(0, classAt);
  const classDecorators = head.slice(head.lastIndexOf('\nimport '));
  const prefix =
    classDecorators
      .match(/@Controller\(\s*(?:'([^']*)'|\{[^}]*path:\s*'([^']*)'[^}]*\})?\s*\)/)
      ?.slice(1)
      .find(Boolean) ?? '';
  const classRoles = classDecorators.match(/@Roles\(([^)]*)\)/s)?.[1];

  const handlers: Handler[] = [];
  let pending = '';
  const lines = source.slice(classAt).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = line.trim();
    if (text.startsWith('@')) {
      // One decorator, possibly spanning lines: read until its parens balance.
      let decorator = text;
      const depth = () =>
        (decorator.match(/\(/g) ?? []).length - (decorator.match(/\)/g) ?? []).length;
      while (depth() > 0 && i + 1 < lines.length) decorator += ` ${lines[++i]!.trim()}`;
      pending += `${decorator}\n`;
      continue;
    }
    const method = line.match(/^ {2}(?:async\s+)?(\w+)\s*\(/)?.[1];
    if (method && pending) {
      const http = pending.match(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/);
      if (http) {
        const roles = pending.match(/@Roles\(([^)]*)\)/s)?.[1] ?? classRoles;
        handlers.push({
          route: `${http[1]!.toUpperCase()} ${[prefix, http[2] ?? ''].filter(Boolean).join('/')}`,
          file,
          method,
          roles: roles === undefined ? null : expand(roles),
        });
      }
      pending = '';
    } else if (/^ {2}\w/.test(line)) {
      // A class member that is not a route handler ends any decorator run.
      pending = '';
    }
  }
  return handlers;
}

describe('back-office route tripwire', () => {
  const root = srcDir();
  const handlers = controllerFiles(root).flatMap((file) =>
    handlersOf(fs.readFileSync(file, 'utf8'), path.relative(root, file)),
  );
  const where = (route: string) =>
    handlers
      .filter((h) => h.route === route)
      .map((h) => `${h.file}#${h.method}`)
      .join(', ');

  it('reads the controllers (sanity: the parser sees the whole API)', () => {
    expect(handlers.length).toBeGreaterThan(150);
    expect(handlers.some((h) => h.route === 'POST auth/login' && h.roles === null)).toBe(true);
    expect(
      handlers.some(
        (h) => h.route === 'GET admin/whish/payments' && h.roles?.includes('BACKOFFICE'),
      ),
      'class-level @Roles must be inherited by handlers',
    ).toBe(true);
    expect(
      handlers.some(
        (h) =>
          h.route === 'POST admin/whish/payments/:id/refresh-status' &&
          !h.roles?.includes('BACKOFFICE'),
      ),
      'a handler-level @Roles must override the class-level one',
    ).toBe(true);
    expect(
      handlers.some((h) => h.route === 'GET notifications' && h.roles?.includes('BACKOFFICE')),
      '@Roles(...LIST) must be expanded',
    ).toBe(true);
  });

  it('every route back office can reach is listed with its fee-free treatment', () => {
    const reachable = handlers.filter((h) => h.roles?.includes('BACKOFFICE')).map((h) => h.route);
    const unlisted = reachable.filter((r) => !(r in BACKOFFICE_ROUTES)).sort();
    expect(
      unlisted,
      `New route(s) reachable by BACKOFFICE: ${unlisted.map((r) => `${r} (${where(r)})`).join('; ')}.\n` +
        `Back office must never see a fee or a figure one can be derived from. Return the ` +
        `response through a view in common/backoffice-view.ts (or confirm it carries no money ` +
        `fields), then add the route to BACKOFFICE_ROUTES in this spec.`,
    ).toEqual([]);
    const stale = Object.keys(BACKOFFICE_ROUTES)
      .filter((r) => !reachable.includes(r))
      .sort();
    expect(
      stale,
      `BACKOFFICE_ROUTES entries back office no longer reaches: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every ungated route is listed', () => {
    const ungated = handlers.filter((h) => h.roles === null).map((h) => h.route);
    const unlisted = ungated.filter((r) => !UNGATED_ROUTES.includes(r)).sort();
    expect(
      unlisted,
      `New route(s) with no @Roles: ${unlisted.map((r) => `${r} (${where(r)})`).join('; ')}.\n` +
        `A handler without @Roles is open to every signed-in role, back office included. Gate ` +
        `it with @Roles(...), or — if it is deliberately open — add it to UNGATED_ROUTES here.`,
    ).toEqual([]);
    const stale = UNGATED_ROUTES.filter((r) => !ungated.includes(r)).sort();
    expect(stale, `UNGATED_ROUTES entries that are now gated or gone: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('the money routes back office reaches really do apply a back-office view', () => {
    // A cheap structural check on top of the list: each controller that serves
    // a 'view' / 'action' route to back office imports the view module.
    const files = new Set(
      handlers
        .filter((h) => {
          const t = BACKOFFICE_ROUTES[h.route];
          return h.roles?.includes('BACKOFFICE') && (t === 'view' || t === 'action');
        })
        .map((h) => h.file),
    );
    for (const file of files) {
      // The bell redacts in its service (the controller only forwards the user).
      const target = file.endsWith('notifications.controller.ts')
        ? file.replace('.controller.ts', '.service.ts')
        : file;
      const source = fs.readFileSync(path.join(root, target), 'utf8');
      expect(source, `${target} serves money to back office without a back-office view`).toMatch(
        /common\/backoffice-view'/,
      );
      expect(source).toMatch(/isBackoffice\(/);
    }
  });
});
