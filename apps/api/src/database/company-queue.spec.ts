import { describe, expect, it } from 'vitest';
import { CompanyQueue } from './company-queue';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('CompanyQueue — one company at a time, companies in parallel', () => {
  it('runs one company’s tasks one at a time, in arrival order', async () => {
    const q = new CompanyQueue();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const task = (i: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      order.push(i);
      running--;
      return i;
    };
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => q.run('co-a', task(i))));
    expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(order).toEqual(results); // arrival order
    expect(maxRunning).toBe(1); // never two at once for one company
  });

  it('different companies run at the same time', async () => {
    const q = new CompanyQueue();
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      running--;
    };
    await Promise.all(['a', 'b', 'c', 'd'].map((co) => q.run(co, task)));
    expect(maxRunning).toBe(4);
  });

  it('a failed task does not hold up the next one, and still reports its own error', async () => {
    const q = new CompanyQueue();
    const failed = q.run('co-a', () => Promise.reject(new Error('conflict')));
    const next = q.run('co-a', async () => 'booked');
    await expect(failed).rejects.toThrow('conflict');
    await expect(next).resolves.toBe('booked');
  });

  it('forgets a company once its line is empty (no unbounded growth)', async () => {
    const q = new CompanyQueue();
    await Promise.all(Array.from({ length: 100 }, (_, i) => q.run(`co-${i}`, async () => i)));
    await tick();
    expect(q.size).toBe(0);
  });
});
