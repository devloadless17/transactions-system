/**
 * The API's background jobs (the Whish poller, CRM delivery, reconciliation,
 * maintenance, withdrawal auto-approval) register here, so a shutdown can stop
 * them from starting a new run and WAIT for a run in progress. Each run moves
 * or records money state (a booking, a delivery, a transfer), so it must
 * finish, not be cut off when the process exits. main.ts does this alongside
 * the HTTP drain, before the database and Redis are closed.
 */
export interface BackgroundJob {
  name: string;
  /** Stop scheduling new runs (clear the timer). */
  stop: () => void;
  /** True while a run is in progress. */
  isRunning: () => boolean;
}

const jobs: BackgroundJob[] = [];

export function registerBackgroundJob(job: BackgroundJob): void {
  jobs.push(job);
}

/** Jobs still running at the deadline are returned (to be logged). */
export async function stopBackgroundJobs(deadlineMs: number): Promise<string[]> {
  for (const job of jobs) job.stop();
  // A monotonic clock: a wall-clock step (NTP) must not stretch or cut the wait.
  const t0 = performance.now();
  while (jobs.some((j) => j.isRunning()) && performance.now() - t0 < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return jobs.filter((j) => j.isRunning()).map((j) => j.name);
}

/** Tests only. */
export function resetBackgroundJobsForTest(): void {
  jobs.length = 0;
}
