/**
 * In-memory counters for background-task errors.
 *
 * Many paths in bwmem deliberately fire-and-forget work (graph sync, fact
 * extraction, behavioral contradiction detection) to keep request latency
 * low. Errors in those paths are logged but otherwise invisible — a chronic
 * failure can silently degrade output quality.
 *
 * This object gives operators a single place to read those counters. The
 * counters are process-local and reset on restart; ship them to a metrics
 * backend via the logger or a separate exporter if durable tracking is
 * needed.
 */
export class BwMemStats {
  private counters: Record<string, number> = Object.create(null);

  increment(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  /** Read a point-in-time copy of all counters. */
  snapshot(): Record<string, number> {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = Object.create(null);
  }
}

/** Singleton used by services that don't have a BwMem reference. */
export const globalStats = new BwMemStats();
