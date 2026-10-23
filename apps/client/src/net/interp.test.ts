import { describe, expect, it } from "vitest";
import { NET } from "@ahb/data";
import { PoseSmoother, ServerClock, SnapshotBuffer, yawOfPose, type Pose } from "./interp.js";

const TICK_MS = 1000 / NET.tickHz;
const PATCH_TICKS = NET.tickHz / NET.patchHz;
const SPEED = 3; // m/s, a brisk walk

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pose = (x: number): Pose => ({ x, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

/**
 * Plays a walking remote player through the clock and buffer, with patches delivered over a
 * route with the given base latency and jitter (in order, as on a WebSocket: a late patch holds
 * up the ones behind it). Returns per-frame statistics after a warm-up.
 */
function play(opts: { baseMs: number; spikeMs: number; spikeChance: number; seconds: number; seed: number }) {
  const rand = rng(opts.seed);
  const clock = new ServerClock({ tickHz: NET.tickHz, patchHz: NET.patchHz, minDelayMs: NET.interpolationDelayMs, maxDelayMs: NET.maxInterpolationDelayMs });
  const buf = new SnapshotBuffer();
  const maxExtrapolate = (NET.maxExtrapolationMs * NET.tickHz) / 1000;
  // Patch send times and arrival times.
  const arrivals: { tick: number; at: number }[] = [];
  let lastArrival = 0;
  for (let tick = 0; tick * TICK_MS < opts.seconds * 1000; tick += PATCH_TICKS) {
    const sent = tick * TICK_MS;
    const spike = rand() < opts.spikeChance ? rand() * opts.spikeMs : rand() * 8;
    lastArrival = Math.max(lastArrival, sent + opts.baseMs + spike);
    arrivals.push({ tick, at: lastArrival });
  }
  const out = pose(0);
  let next = 0;
  let prevX: number | null = null;
  let frames = 0;
  let late = 0;
  let backwards = 0;
  let maxStep = 0;
  const frameMs = 1000 / 60;
  for (let now = 0; now < opts.seconds * 1000; now += frameMs) {
    while (next < arrivals.length && arrivals[next]!.at <= now) {
      const a = arrivals[next++]!;
      buf.push(a.tick, pose((a.tick * SPEED) / NET.tickHz));
      clock.observe(a.tick, now);
    }
    clock.tick(frameMs);
    const fresh = buf.sample(clock.renderTick(now), out, maxExtrapolate);
    if (!fresh) clock.reportUnderrun();
    if (now < 5000) {
      prevX = out.x;
      continue;
    }
    frames++;
    if (!fresh) late++;
    if (prevX !== null) {
      if (out.x < prevX - 1e-6) backwards++;
      maxStep = Math.max(maxStep, out.x - prevX);
    }
    prevX = out.x;
  }
  return { lateFraction: late / frames, backwards, maxStep, delayMs: clock.delayTicks * TICK_MS };
}

describe("remote interpolation over a long route", () => {
  const perFrame = (SPEED * 1) / 60;

  it("stays at the minimum delay on a clean connection", () => {
    const r = play({ baseMs: 40, spikeMs: 0, spikeChance: 0, seconds: 20, seed: 1 });
    expect(r.lateFraction).toBe(0);
    expect(r.backwards).toBe(0);
    expect(r.delayMs).toBeCloseTo(NET.interpolationDelayMs, 0);
  });

  it("keeps motion continuous on a jittery Thailand to US route", () => {
    // ~220 ms one way with frequent spikes of up to 180 ms (TCP retransmits, Wi-Fi).
    const r = play({ baseMs: 220, spikeMs: 180, spikeChance: 0.15, seconds: 60, seed: 7 });
    expect(r.lateFraction).toBeLessThan(0.01);
    expect(r.backwards).toBe(0);
    // No visible jumps: a frame never moves more than twice the walking distance per frame.
    expect(r.maxStep).toBeLessThan(perFrame * 2);
    expect(r.delayMs).toBeLessThanOrEqual(NET.maxInterpolationDelayMs);
  });

  it("shrinks the delay again once the jitter is gone", () => {
    const clock = new ServerClock({ tickHz: NET.tickHz, patchHz: NET.patchHz, minDelayMs: 100, maxDelayMs: 500 });
    let now = 0;
    // A burst of late patches, then 30 s of punctual ones.
    for (let tick = 0; tick < 60 * 40; tick += PATCH_TICKS) {
      const lateBy = tick > 120 && tick < 300 && tick % 12 === 0 ? 200 : 0;
      now = tick * TICK_MS + 50 + lateBy;
      clock.observe(tick, now);
      for (let f = 0; f < 3; f++) clock.tick(TICK_MS);
    }
    expect(clock.delayTicks * TICK_MS).toBeLessThan(140);
  });
});

describe("SnapshotBuffer", () => {
  it("continues motion briefly past the newest snapshot, then holds", () => {
    const buf = new SnapshotBuffer();
    buf.push(0, pose(0));
    buf.push(3, pose(0.15));
    const out = pose(0);
    expect(buf.sample(1.5, out, 6)).toBe(true);
    expect(out.x).toBeCloseTo(0.075);
    expect(buf.sample(6, out, 6)).toBe(false);
    expect(out.x).toBeCloseTo(0.3);
    buf.sample(30, out, 6);
    expect(out.x).toBeCloseTo(0.45); // capped at 6 ticks past the newest
  });

  it("never extrapolates a teleport", () => {
    const buf = new SnapshotBuffer();
    buf.push(0, pose(0));
    buf.push(3, pose(4));
    const out = pose(0);
    buf.sample(6, out, 6);
    expect(out.x).toBe(4);
  });
});

describe("PoseSmoother", () => {
  it("fades a jump out instead of showing it, and lets real teleports through", () => {
    const sm = new PoseSmoother();
    const p = pose(0);
    sm.apply(p, 1 / 60);
    // The source changes: the new pose is 0.3 m away.
    sm.blend();
    const q = pose(0.3);
    sm.apply(q, 1 / 60);
    // Eases in: under a third of the way on the first frame, then steadily the rest.
    expect(q.x).toBeLessThan(0.1);
    let x = q.x;
    for (let i = 0; i < 20; i++) {
      const r = pose(0.3);
      sm.apply(r, 1 / 60);
      expect(r.x).toBeGreaterThanOrEqual(x);
      x = r.x;
    }
    expect(x).toBeGreaterThan(0.29);

    sm.blend();
    const far = pose(5);
    sm.apply(far, 1 / 60);
    expect(far.x).toBe(5);
  });

  it("blends rotation along with position", () => {
    const sm = new PoseSmoother();
    sm.apply(pose(0), 1 / 60);
    sm.blend();
    const half = Math.SQRT1_2;
    const turned: Pose = { x: 0, y: 0, z: 0, qx: 0, qy: half, qz: 0, qw: half }; // 90 degrees
    sm.apply(turned, 1 / 60);
    expect(Math.abs(yawOfPose(turned))).toBeLessThan(Math.PI / 6);
    for (let i = 0; i < 30; i++) {
      const r: Pose = { x: 0, y: 0, z: 0, qx: 0, qy: half, qz: 0, qw: half };
      sm.apply(r, 1 / 60);
      Object.assign(turned, r);
    }
    expect(yawOfPose(turned)).toBeCloseTo(Math.PI / 2, 2);
  });
});
