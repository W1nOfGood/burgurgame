/**
 * Fixed-step accumulator with bounded catch-up (spec §14: avoid unlimited catch-up after stalls).
 */
export class FixedStepper {
  readonly stepMs: number;
  private accumulator = 0;
  private readonly maxSteps: number;

  constructor(hz: number, maxCatchUpSteps = 4) {
    this.stepMs = 1000 / hz;
    this.maxSteps = maxCatchUpSteps;
  }

  /** Feeds elapsed milliseconds and runs `step` zero or more times. Returns steps run. */
  advance(elapsedMs: number, step: (dtSeconds: number) => void): number {
    this.accumulator += Math.max(0, elapsedMs);
    let steps = 0;
    while (this.accumulator >= this.stepMs && steps < this.maxSteps) {
      step(this.stepMs / 1000);
      this.accumulator -= this.stepMs;
      steps++;
    }
    if (steps === this.maxSteps && this.accumulator >= this.stepMs) {
      // Drop the backlog instead of spiralling.
      this.accumulator = this.accumulator % this.stepMs;
    }
    return steps;
  }

  /** 0..1 fraction toward the next step, for render interpolation. */
  get alpha(): number {
    return this.accumulator / this.stepMs;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
