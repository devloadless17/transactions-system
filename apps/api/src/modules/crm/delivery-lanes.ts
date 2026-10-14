/**
 * In-process scheduling of outbound CRM deliveries.
 *
 * - At most `maxInFlight` deliveries run at once from this API, and at most
 *   `perCompany` to any one company's CRM. A slow or failing CRM therefore
 *   holds a few slots — never everyone's — and a burst for one company does not
 *   open thousands of connections to that company's server at once.
 * - A free slot goes to the waiting company served least recently, so a company
 *   with a long queue cannot keep the others waiting behind it.
 * - Bounded: past `maxQueued` waiting deliveries `run` declines, and the caller
 *   leaves the delivery to the retry sweep (it is a durable row either way).
 */
export class DeliveryLanes {
  private active = 0;
  private readonly activeBy = new Map<string, number>();
  private readonly waiting = new Map<string, Array<Waiting>>();
  // When each company last had a delivery started (a running count).
  private readonly lastServed = new Map<string, number>();
  private served = 0;
  private queued = 0;
  private closed = false;

  constructor(
    private readonly opts: { maxInFlight: number; perCompany: number; maxQueued: number },
  ) {}

  /** Deliveries running now. */
  get inFlight(): number {
    return this.active;
  }

  /** Deliveries waiting for a slot. */
  get waitingCount(): number {
    return this.queued;
  }

  /**
   * Queue `task` for `companyId`. Resolves when it has run, or was dropped by a
   * shutdown; never rejects. Null when declined (the queue is full, or a
   * shutdown has begun).
   */
  run(companyId: string, task: () => Promise<void>): Promise<void> | null {
    if (this.closed || this.queued >= this.opts.maxQueued) return null;
    return new Promise<void>((done) => {
      const entry: Waiting = { task, done };
      const q = this.waiting.get(companyId);
      if (q) q.push(entry);
      else this.waiting.set(companyId, [entry]);
      this.queued++;
      this.pump();
    });
  }

  /** Shutdown: nothing waiting starts any more; what is running finishes. */
  close(): void {
    this.closed = true;
    for (const q of this.waiting.values()) for (const w of q) w.done();
    this.waiting.clear();
    this.queued = 0;
  }

  private pump(): void {
    while (!this.closed && this.active < this.opts.maxInFlight) {
      let pick: string | undefined;
      let oldest = Infinity;
      for (const companyId of this.waiting.keys()) {
        if ((this.activeBy.get(companyId) ?? 0) >= this.opts.perCompany) continue;
        const at = this.lastServed.get(companyId) ?? -1;
        if (at < oldest) {
          oldest = at;
          pick = companyId;
        }
      }
      if (pick === undefined) return;
      const q = this.waiting.get(pick)!;
      const entry = q.shift()!;
      if (!q.length) this.waiting.delete(pick);
      this.queued--;
      this.lastServed.set(pick, ++this.served);
      this.start(pick, entry);
    }
  }

  private start(companyId: string, entry: Waiting): void {
    this.active++;
    this.activeBy.set(companyId, (this.activeBy.get(companyId) ?? 0) + 1);
    let running: Promise<void>;
    try {
      // Started synchronously, so a shutdown requested by this task is seen
      // before the next one starts.
      running = entry.task();
    } catch (err) {
      running = Promise.reject(err);
    }
    void running
      .catch(() => undefined)
      .finally(() => {
        this.active--;
        const left = (this.activeBy.get(companyId) ?? 1) - 1;
        if (left > 0) this.activeBy.set(companyId, left);
        else this.activeBy.delete(companyId);
        entry.done();
        this.pump();
      });
  }
}

interface Waiting {
  task: () => Promise<void>;
  done: () => void;
}
