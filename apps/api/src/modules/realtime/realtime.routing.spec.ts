import { describe, expect, it, vi } from 'vitest';
import type { RealtimeInvalidate } from '@app/shared';
import { ADMIN_ROOM, companyRoom, RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

// ---------------------------------------------------------------------------
// Realtime tenant-safety invariant (the realtime analog of RLS):
//   - a company() emit reaches ONLY that company's room + the admin room, and
//     NEVER a sibling tenant's room;
//   - an admin() emit reaches ONLY the admin room, never any company room;
//   - the wire payload carries no domain data — only invalidate hints
//     (topics + companyId), so even a mis-routed frame leaks nothing.
//   - a company user's handshake joins ONLY their own room, never ADMIN_ROOM.
// ---------------------------------------------------------------------------

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

/** Captures the (rooms, payload) pairs the service hands to the gateway. */
function captureGateway() {
  const emits: { rooms: string[]; payload: RealtimeInvalidate }[] = [];
  const gateway = {
    emit: (rooms: string[], payload: RealtimeInvalidate) => emits.push({ rooms, payload }),
  } as unknown as RealtimeGateway;
  return { gateway, emits };
}

describe('RealtimeService room routing', () => {
  it('company() targets ONLY that company room + admin room', () => {
    const { gateway, emits } = captureGateway();
    new RealtimeService(gateway).company(COMPANY_A, ['whish']);

    expect(emits).toHaveLength(1);
    expect(emits[0].rooms).toEqual([companyRoom(COMPANY_A), ADMIN_ROOM]);
  });

  it('company() NEVER targets a sibling tenant room', () => {
    const { gateway, emits } = captureGateway();
    new RealtimeService(gateway).company(COMPANY_A, ['transactions', 'wallets']);

    expect(emits[0].rooms).not.toContain(companyRoom(COMPANY_B));
    // Defence-in-depth: only ever exactly two rooms, both known.
    expect(emits[0].rooms).toHaveLength(2);
    for (const r of emits[0].rooms) {
      expect(r === companyRoom(COMPANY_A) || r === ADMIN_ROOM).toBe(true);
    }
  });

  it('admin() targets ONLY the admin room — never any company room', () => {
    const { gateway, emits } = captureGateway();
    // Even when a companyId is supplied as a refresh hint, it must NOT become a room.
    new RealtimeService(gateway).admin(['companies'], COMPANY_A);

    expect(emits[0].rooms).toEqual([ADMIN_ROOM]);
    expect(emits[0].rooms).not.toContain(companyRoom(COMPANY_A));
  });

  it('the wire payload carries only invalidate hints (no domain data)', () => {
    const { gateway, emits } = captureGateway();
    new RealtimeService(gateway).company(COMPANY_A, ['whish']);

    // Exhaustive key check: a future careless edit that bolts a domain field
    // (settlementError, adminNotes, sourceFee, netRevenue, …) onto the payload
    // would add a key here and fail this test.
    expect(Object.keys(emits[0].payload).sort()).toEqual(['companyId', 'topics']);
    expect(emits[0].payload).toEqual({ topics: ['whish'], companyId: COMPANY_A });
  });
});

describe('RealtimeGateway emit fan-out', () => {
  it('emits the invalidate event to exactly the rooms it is given', () => {
    const to = vi.fn().mockReturnValue({ emit: vi.fn() });
    const gateway = new RealtimeGateway({} as never, {} as never);
    (gateway as unknown as { server: { to: typeof to } }).server = { to };

    const payload: RealtimeInvalidate = { topics: ['whish'], companyId: COMPANY_A };
    gateway.emit([companyRoom(COMPANY_A), ADMIN_ROOM], payload);

    expect(to).toHaveBeenCalledWith([companyRoom(COMPANY_A), ADMIN_ROOM]);
    expect(to.mock.results[0].value.emit).toHaveBeenCalledWith('invalidate', payload);
  });

  it('is a no-op (no throw) before the server is ready or with no rooms', () => {
    const gateway = new RealtimeGateway({} as never, {} as never);
    // server still undefined
    expect(() => gateway.emit([ADMIN_ROOM], { topics: ['whish'], companyId: null })).not.toThrow();
    // server ready but empty room list
    (gateway as unknown as { server: { to: () => never } }).server = {
      to: () => {
        throw new Error('to() must not be called for an empty room list');
      },
    };
    expect(() => gateway.emit([], { topics: ['whish'], companyId: null })).not.toThrow();
  });
});

describe('RealtimeGateway handshake room join', () => {
  /** Build a gateway whose JWT verify resolves to the given access-token payload. */
  function gatewayWithToken(payload: { companyId: string | null }) {
    const jwt = { verifyAsync: vi.fn().mockResolvedValue(payload) };
    const config = { get: vi.fn().mockReturnValue('secret') };
    const gateway = new RealtimeGateway(jwt as never, config as never);
    const join = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn();
    const client = {
      id: 'sock1',
      handshake: { headers: { cookie: 'txn_access=tok' } },
      join,
      disconnect,
    };
    return { gateway, client, join, disconnect };
  }

  it('a company user joins ONLY their own room, never ADMIN_ROOM', async () => {
    const { gateway, client, join, disconnect } = gatewayWithToken({ companyId: COMPANY_A });
    await gateway.handleConnection(client as never);

    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith(companyRoom(COMPANY_A));
    expect(join).not.toHaveBeenCalledWith(ADMIN_ROOM);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('an admin (companyId=null) joins ONLY the admin room, never a company room', async () => {
    const { gateway, client, join } = gatewayWithToken({ companyId: null });
    await gateway.handleConnection(client as never);

    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith(ADMIN_ROOM);
  });

  it('a handshake with no access cookie is rejected and joins nothing', async () => {
    const { gateway, join, disconnect } = gatewayWithToken({ companyId: COMPANY_A });
    const client = { id: 's', handshake: { headers: {} }, join, disconnect };
    await gateway.handleConnection(client as never);

    expect(join).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith(true);
  });
});
