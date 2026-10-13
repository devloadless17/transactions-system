/**
 * Runs the money transactions of ONE company one at a time, in arrival order,
 * while different companies still run in parallel.
 *
 * Every deposit, withdrawal, payout and load of a company updates that
 * company's wallet row inside a SERIALIZABLE transaction. When many of them
 * arrive at the same moment — a big company whose customers pay at once — they
 * all race for that one row. Postgres keeps the money correct by aborting all
 * but one, and the losers retry a few times and then FAIL: a burst of 300 Whish
 * payments for one company booked only 129 immediately (the rest waited for the
 * reconciliation poller), and a source pushing deposits in parallel would get
 * WRITE_CONFLICT for the excess.
 *
 * Queuing them here, before the transaction starts, turns that race into an
 * orderly line: each transaction runs alone for its company, so none conflicts
 * and none is retried — a burst is booked at the database's full speed for one
 * wallet, in the order it arrived. Correctness never depends on this: SERIALIZABLE
 * isolation (and its retry) still guards every transaction, e.g. across several
 * API instances, which each keep their own line.
 *
 * Never reentrant — a money transaction must not start another one for the
 * same company from inside its callback (none does; they only use the `tx`
 * they are given). A task that fails does not hold up the next one.
 */
export class CompanyQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` after every earlier task of `companyId` has finished. */
  run<T>(companyId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(companyId) ?? Promise.resolve();
    const result = previous.then(task);
    // The line moves on whatever this task's outcome.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(companyId, tail);
    void tail.then(() => {
      // Drop an idle company's entry so the map never grows without bound.
      if (this.tails.get(companyId) === tail) this.tails.delete(companyId);
    });
    return result;
  }

  /** Companies with work queued or running (for tests and diagnostics). */
  get size(): number {
    return this.tails.size;
  }
}
