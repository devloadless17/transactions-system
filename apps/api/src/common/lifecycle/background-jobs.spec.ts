import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerBackgroundJob,
  resetBackgroundJobsForTest,
  stopBackgroundJobs,
} from './background-jobs';

/**
 * A shutdown must not cut a background run in the middle (a booking, a CRM
 * delivery, a transfer): every job stops scheduling, and a run in progress
 * finishes before the database is closed.
 */
describe('stopBackgroundJobs', () => {
  afterEach(() => resetBackgroundJobsForTest());

  it('stops every job and waits for the run in progress to finish', async () => {
    let running = true;
    const stopA = vi.fn();
    const stopB = vi.fn();
    registerBackgroundJob({ name: 'busy', stop: stopA, isRunning: () => running });
    registerBackgroundJob({ name: 'idle', stop: stopB, isRunning: () => false });
    setTimeout(() => {
      running = false;
    }, 200);

    const t0 = Date.now();
    await expect(stopBackgroundJobs(5_000)).resolves.toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).toHaveBeenCalledOnce();
  });

  it('gives up at the deadline and names the job still running', async () => {
    registerBackgroundJob({ name: 'stuck', stop: vi.fn(), isRunning: () => true });
    await expect(stopBackgroundJobs(120)).resolves.toEqual(['stuck']);
  });

  it('returns at once when nothing is running', async () => {
    registerBackgroundJob({ name: 'idle', stop: vi.fn(), isRunning: () => false });
    const t0 = Date.now();
    await stopBackgroundJobs(5_000);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
