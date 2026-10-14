import { describe, expect, it } from 'vitest';
import { DeliveryLanes } from './delivery-lanes';

/** A task that stays running until released, recording that it started. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const finished = new Promise<void>((r) => (release = r));
  return {
    task: () => {
      log.push(name);
      return finished;
    },
    release: () => release(),
  };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('DeliveryLanes — bounded, and fair across companies', () => {
  it('never runs more than the per-company limit to one CRM', async () => {
    const lanes = new DeliveryLanes({ maxInFlight: 10, perCompany: 2, maxQueued: 100 });
    const log: string[] = [];
    const gates = Array.from({ length: 5 }, (_, i) => gate(log, `a${i}`));
    for (const g of gates) lanes.run('A', g.task);

    expect(log).toEqual(['a0', 'a1']);
    expect(lanes.inFlight).toBe(2);
    expect(lanes.waitingCount).toBe(3);

    gates[0]!.release();
    await tick();
    expect(log).toEqual(['a0', 'a1', 'a2']); // the next one takes the free slot
  });

  it('a slow company cannot hold up the others', async () => {
    const lanes = new DeliveryLanes({ maxInFlight: 4, perCompany: 2, maxQueued: 100 });
    const log: string[] = [];
    // Company A queues a long backlog first (its CRM is slow: nothing finishes)…
    for (let i = 0; i < 50; i++) lanes.run('A', gate(log, `a${i}`).task);
    // …then B and C each have one delivery.
    lanes.run('B', gate(log, 'b0').task);
    lanes.run('C', gate(log, 'c0').task);

    // A holds only its 2 slots; B and C start at once.
    expect(log).toEqual(['a0', 'a1', 'b0', 'c0']);
  });

  it('takes waiting companies in turn', async () => {
    const lanes = new DeliveryLanes({ maxInFlight: 1, perCompany: 1, maxQueued: 100 });
    const log: string[] = [];
    const a = [gate(log, 'a0'), gate(log, 'a1'), gate(log, 'a2')];
    const b = [gate(log, 'b0'), gate(log, 'b1')];
    for (const g of a) lanes.run('A', g.task);
    for (const g of b) lanes.run('B', g.task);

    for (const g of [a[0], b[0], a[1], b[1]]) {
      g!.release();
      await tick();
    }
    expect(log).toEqual(['a0', 'b0', 'a1', 'b1', 'a2']);
  });

  it('declines past maxQueued, so memory stays bounded (the sweep takes those)', () => {
    const lanes = new DeliveryLanes({ maxInFlight: 1, perCompany: 1, maxQueued: 2 });
    const log: string[] = [];
    expect(lanes.run('A', gate(log, 'a0').task)).not.toBeNull(); // running
    expect(lanes.run('A', gate(log, 'a1').task)).not.toBeNull(); // waiting 1
    expect(lanes.run('A', gate(log, 'a2').task)).not.toBeNull(); // waiting 2
    expect(lanes.run('A', gate(log, 'a3').task)).toBeNull();
  });

  it('a failing task frees its slot and never rejects the caller', async () => {
    const lanes = new DeliveryLanes({ maxInFlight: 1, perCompany: 1, maxQueued: 10 });
    const log: string[] = [];
    const failed = lanes.run('A', () => Promise.reject(new Error('CRM down')));
    lanes.run('A', gate(log, 'a1').task);

    await expect(failed).resolves.toBeUndefined();
    await tick();
    expect(log).toEqual(['a1']);
  });

  it('a shutdown starts nothing more; waiting callers are released, running ones finish', async () => {
    const lanes = new DeliveryLanes({ maxInFlight: 1, perCompany: 1, maxQueued: 10 });
    const log: string[] = [];
    const running = gate(log, 'a0');
    const first = lanes.run('A', running.task)!;
    const waiting = lanes.run('A', gate(log, 'a1').task)!;

    lanes.close();
    await expect(waiting).resolves.toBeUndefined(); // dropped, not hung
    expect(lanes.run('A', gate(log, 'a2').task)).toBeNull();

    running.release();
    await first;
    await tick();
    expect(log).toEqual(['a0']);
    expect(lanes.inFlight).toBe(0);
  });
});
