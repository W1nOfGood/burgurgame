/**
 * Remote entity interpolation (spec §14: adaptive remote interpolation, ~100 ms initially).
 * Snapshots are keyed by authoritative server tick, so jitter in packet arrival does not distort
 * motion. The render clock trails the server by a delay sized from measured arrival jitter, so
 * on a long, jittery route (say Thailand to a US server) remote players and items keep moving
 * smoothly instead of freezing and jumping when a patch is late.
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
/** A last step longer than this (m) is a teleport or a grab, not motion: never extrapolate it. */
const MAX_EXTRAPOLATED_STEP = 0.5;

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

  /**
   * Writes the pose at render tick `t` into `out`. Past the newest snapshot the last motion is
   * continued for up to `maxExtrapolateTicks`, then held. Returns false when `t` is past the
   * newest snapshot (the data ran late).
   */
  sample(t: number, out: Pose, maxExtrapolateTicks = 0): boolean {
    const s = this.snaps;
    if (s.length === 0) return false;
    if (t <= s[0]!.t) {
      Object.assign(out, s[0]);
      return true;
    }
    const b = s[s.length - 1]!;
    if (t > b.t) {
      Object.assign(out, b);
      const a = s[s.length - 2];
      if (a && maxExtrapolateTicks > 0) {
        const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (step > 0 && step <= MAX_EXTRAPOLATED_STEP) {
          const k = Math.min(t - b.t, maxExtrapolateTicks) / (b.t - a.t);
          out.x = b.x + (b.x - a.x) * k;
          out.y = b.y + (b.y - a.y) * k;
          out.z = b.z + (b.z - a.z) * k;
        }
      }
      return false;
    }
    for (let i = s.length - 1; i > 0; i--) {
      const hi = s[i]!;
      const lo = s[i - 1]!;
      if (t >= lo.t && t <= hi.t) {
        lerpPose(lo, hi, hi.t === lo.t ? 1 : (t - lo.t) / (hi.t - lo.t), out);
        return true;
      }
    }
    Object.assign(out, b);
    return true;
  }
}

export function lerpPose(a: Pose, b: Pose, k: number, out: Pose): void {
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  nlerpQuat(a, b, k, out);
}

type Quat = Pick<Pose, "qx" | "qy" | "qz" | "qw">;

/** Normalised lerp along the shortest arc. */
function nlerpQuat(a: Quat, b: Quat, k: number, out: Quat): void {
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

/** Yaw (radians about +Y) of a rotation that is a pure yaw. */
export function yawOfPose(q: Quat): number {
  return 2 * Math.atan2(q.qy, q.qw);
}

/**
 * Estimates the server's current tick from patch arrivals and how far behind it to render.
 *
 * The clock offset follows the freshest arrivals quickly and late ones slowly. How late each
 * patch is relative to that offset is the arrival jitter; its recent peak (decaying over a few
 * seconds) sets the interpolation delay: one patch interval plus the peak jitter plus a small
 * margin, between the configured minimum and maximum. The delay rises quickly when jitter
 * appears and falls back slowly, so playback stays continuous: changing the delay only plays
 * remote motion slightly slower or faster for a moment, never makes it jump.
 */
export class ServerClock {
  private offset: number | null = null;
  private readonly tickMs: number;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly patchTicks: number;
  private lastArrival: number | null = null;
  /** Current interpolation delay in ticks. */
  delayTicks: number;
  /** Recent peak lateness of patch arrivals, in ticks. */
  jitterTicks = 0;

  constructor(opts: { tickHz: number; patchHz: number; minDelayMs: number; maxDelayMs: number }) {
    this.tickMs = 1000 / opts.tickHz;
    this.minDelay = opts.minDelayMs / this.tickMs;
    this.maxDelay = Math.max(this.minDelay, opts.maxDelayMs / this.tickMs);
    this.patchTicks = opts.tickHz / opts.patchHz;
    this.delayTicks = this.minDelay;
  }

  observe(tick: number, nowMs: number): void {
    const sample = tick - nowMs / this.tickMs;
    // A jump of seconds (first patch, a long stall, a server restart): start over.
    if (this.offset === null || Math.abs(sample - this.offset) > this.maxDelay * 4) {
      this.offset = sample;
      this.lastArrival = nowMs;
      return;
    }
    if (sample > this.offset) this.offset += (sample - this.offset) * 0.25;
    else this.offset += (sample - this.offset) * 0.02;
    const late = Math.max(0, this.offset - sample);
    const since = this.lastArrival === null ? 0 : nowMs - this.lastArrival;
    this.lastArrival = nowMs;
    this.jitterTicks = Math.max(late, this.jitterTicks * Math.exp(-since / 6000));
  }

  now(nowMs: number): number {
    return this.offset === null ? 0 : nowMs / this.tickMs + this.offset;
  }

  renderTick(nowMs: number): number {
    return this.now(nowMs) - this.delayTicks;
  }

  /** The delay the clock is easing towards, in ticks. */
  get targetDelayTicks(): number {
    return Math.min(this.maxDelay, Math.max(this.minDelay, this.patchTicks + this.jitterTicks + 1));
  }

  /** Call when a sample ran past the newest snapshot: the jitter is larger than measured. */
  reportUnderrun(): void {
    this.jitterTicks = Math.min(this.maxDelay, this.jitterTicks + 0.25);
  }

  /** Call once per frame: eases the delay towards its target (up within ~0.2 s, down over seconds). */
  tick(dtMs: number): void {
    const target = this.targetDelayTicks;
    const elapsed = dtMs / this.tickMs;
    if (target > this.delayTicks) this.delayTicks = Math.min(target, this.delayTicks + elapsed * 0.25);
    else this.delayTicks = Math.max(target, this.delayTicks - elapsed * 0.04);
  }
}

/**
 * Hides a discontinuity in what is shown without delaying real motion: when the pose's source
 * changes (an item leaves the hand, a late patch ends an extrapolation), call `blend()` and the
 * gap between the old and new pose becomes an offset that fades out over ~150 ms.
 */
export class PoseSmoother {
  private shown: Pose | null = null;
  private readonly off: Pose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private pending = false;

  /** The next `apply` starts from the pose shown last instead of jumping to the new one. */
  blend(): void {
    this.pending = true;
  }

  /** Adjusts `pose` in place. Gaps larger than `snapDistance` (m) are real teleports and jump. */
  apply(pose: Pose, dtSec: number, snapDistance = 1.5): void {
    const o = this.off;
    if (this.pending && this.shown) {
      const s = this.shown;
      o.x = s.x - pose.x;
      o.y = s.y - pose.y;
      o.z = s.z - pose.z;
      if (Math.hypot(o.x, o.y, o.z) > snapDistance) {
        o.x = o.y = o.z = 0;
        o.qx = o.qy = o.qz = 0;
        o.qw = 1;
      } else {
        // Rotation offset: shown * inverse(pose).
        mulQuat(s, { qx: -pose.qx, qy: -pose.qy, qz: -pose.qz, qw: pose.qw }, o);
      }
    }
    this.pending = false;
    const k = Math.exp(-dtSec * 20);
    o.x *= k;
    o.y *= k;
    o.z *= k;
    nlerpQuat(IDENTITY, o, k, o);
    pose.x += o.x;
    pose.y += o.y;
    pose.z += o.z;
    if (o.qw < 0.999999) mulQuat(o, pose, pose);
    this.shown ??= { ...pose };
    Object.assign(this.shown, pose);
  }
}

const IDENTITY: Quat = { qx: 0, qy: 0, qz: 0, qw: 1 };

/** out = a * b (out may alias either). */
function mulQuat(a: Quat, b: Quat, out: Quat): void {
  const x = a.qw * b.qx + a.qx * b.qw + a.qy * b.qz - a.qz * b.qy;
  const y = a.qw * b.qy - a.qx * b.qz + a.qy * b.qw + a.qz * b.qx;
  const z = a.qw * b.qz + a.qx * b.qy - a.qy * b.qx + a.qz * b.qw;
  const w = a.qw * b.qw - a.qx * b.qx - a.qy * b.qy - a.qz * b.qz;
  out.qx = x;
  out.qy = y;
  out.qz = z;
  out.qw = w;
}
