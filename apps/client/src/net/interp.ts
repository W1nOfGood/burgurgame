/**
 * Remote entity interpolation (spec §14: adaptive remote interpolation, ~100 ms initially).
 * Snapshots are keyed by authoritative server tick, so jitter in packet arrival does not distort
 * motion.
 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

interface Snap extends Pose {
  t: number;
}

const MAX_SNAPS = 40;

export class SnapshotBuffer {
  private snaps: Snap[] = [];

  push(t: number, p: Pose): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && t <= last.t) {
      if (t === last.t) Object.assign(last, p);
      return;
    }
    this.snaps.push({ t, ...p });
    if (this.snaps.length > MAX_SNAPS) this.snaps.shift();
  }

  get latest(): Snap | undefined {
    return this.snaps[this.snaps.length - 1];
  }

  clear(): void {
    this.snaps.length = 0;
  }

  /** Writes the pose at render tick `t` into `out`. Returns false if `t` is past the newest snapshot. */
  sample(t: number, out: Pose): boolean {
    const s = this.snaps;
    if (s.length === 0) return false;
    if (t <= s[0]!.t) {
      Object.assign(out, s[0]);
      return true;
    }
    for (let i = s.length - 1; i > 0; i--) {
      const b = s[i]!;
      const a = s[i - 1]!;
      if (t >= a.t && t <= b.t) {
        const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
        lerpPose(a, b, k, out);
        return true;
      }
    }
    Object.assign(out, s[s.length - 1]);
    return false;
  }
}

export function lerpPose(a: Pose, b: Pose, k: number, out: Pose): void {
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  // Normalised lerp along the shortest arc.
  let bx = b.qx;
  let by = b.qy;
  let bz = b.qz;
  let bw = b.qw;
  if (a.qx * bx + a.qy * by + a.qz * bz + a.qw * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = a.qx + (bx - a.qx) * k;
  const y = a.qy + (by - a.qy) * k;
  const z = a.qz + (bz - a.qz) * k;
  const w = a.qw + (bw - a.qw) * k;
  const len = Math.hypot(x, y, z, w) || 1;
  out.qx = x / len;
  out.qy = y / len;
  out.qz = z / len;
  out.qw = w / len;
}

/**
 * Estimates the server's current tick from patch arrivals. The estimate follows late packets
 * slowly and early ones quickly, which keeps the clock near the freshest data without jumping.
 */
export class ServerClock {
  private offset: number | null = null;
  private readonly tickMs: number;
  /** Interpolation delay in ticks, adapted to observed jitter. */
  delayTicks: number;
  private underruns = 0;
  private stableFor = 0;

  constructor(tickHz: number, delayMs: number) {
    this.tickMs = 1000 / tickHz;
    this.delayTicks = delayMs / this.tickMs;
  }

  observe(tick: number, nowMs: number): void {
    const sample = tick - nowMs / this.tickMs;
    if (this.offset === null || Math.abs(sample - this.offset) > 120) this.offset = sample;
    else if (sample > this.offset) this.offset += (sample - this.offset) * 0.25;
    else this.offset += (sample - this.offset) * 0.02;
  }

  now(nowMs: number): number {
    return this.offset === null ? 0 : nowMs / this.tickMs + this.offset;
  }

  renderTick(nowMs: number): number {
    return this.now(nowMs) - this.delayTicks;
  }

  /** Call when a sample ran past the newest snapshot: widen the delay a little. */
  reportUnderrun(): void {
    this.underruns++;
    if (this.underruns > 3) {
      this.delayTicks = Math.min(15, this.delayTicks + 0.6);
      this.underruns = 0;
      this.stableFor = 0;
    }
  }

  /** Call once per frame with frame time: slowly tighten the delay while playback is smooth. */
  tick(dtMs: number, minDelayMs: number): void {
    this.stableFor += dtMs;
    if (this.stableFor > 5000) {
      this.stableFor = 0;
      this.underruns = 0;
      this.delayTicks = Math.max(minDelayMs / this.tickMs, this.delayTicks - 0.3);
    }
  }
}
