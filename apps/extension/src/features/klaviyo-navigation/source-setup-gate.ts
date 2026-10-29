/**
 * Serializes one-time source setup against automatic navigation. While a Subscriber Growth source is being validated
 * (in the service worker) or persisted (by the panel), no automatic capture may navigate the granted Klaviyo tab.
 * Every held state is bounded: a stage that is never released returns to IDLE on its own, so nothing stays stuck.
 */
export type SourceSetupState = "IDLE" | "VALIDATING" | "PERSISTING";

export class SourceSetupGate {
  private current: SourceSetupState = "IDLE";
  private release: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];
  constructor(private readonly maxHoldMs = 30_000) {}

  get state(): SourceSetupState { return this.current; }

  begin(state: Exclude<SourceSetupState, "IDLE">): void {
    this.current = state;
    if (this.release) clearTimeout(this.release);
    this.release = setTimeout(() => this.end(), this.maxHoldMs);
  }

  end(): void {
    if (this.release) clearTimeout(this.release);
    this.release = null; this.current = "IDLE";
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Resolves true once setup is idle, or false when the bounded wait ends first. */
  async waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.current === "IDLE") return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((wake) => wake !== done); resolve(false); }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(true); };
      this.waiters.push(done);
    });
  }
}
