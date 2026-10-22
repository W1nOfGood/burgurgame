import { PlayerMotor, createPhysicsWorld, type MoveSample, type PhysicsWorld, type Rapier, type V3 } from "@ahb/simulation";

/**
 * Client prediction for the local player (spec §3/§14): the same Rapier build and motor as the
 * server, replaying unacknowledged samples after every authoritative update. Visual error from a
 * correction is folded into an offset that decays smoothly instead of snapping.
 */
export class LocalPlayer {
  readonly pw: PhysicsWorld;
  readonly motor: PlayerMotor;
  private seq = 0;
  private pending: MoveSample[] = [];
  private outbox: MoveSample[] = [];
  readonly offset = { x: 0, y: 0, z: 0 };
  lastCorrection = 0;

  constructor(R: Rapier, start: V3) {
    this.pw = createPhysicsWorld(R);
    this.motor = new PlayerMotor(this.pw, start);
  }

  /** Simulates one fixed step locally and queues it for the server. */
  step(sample: Omit<MoveSample, "seq">, dt: number, speedFactor: number): MoveSample {
    const s: MoveSample = { ...sample, seq: ++this.seq };
    this.motor.step(s, dt, speedFactor);
    this.pending.push(s);
    this.outbox.push(s);
    if (this.pending.length > 240) this.pending.splice(0, this.pending.length - 240);
    if (this.outbox.length > 30) this.outbox.splice(0, this.outbox.length - 30);
    return s;
  }

  /** Takes up to `max` queued samples for the next input message. */
  drainOutbox(max: number): MoveSample[] {
    return this.outbox.splice(0, max);
  }

  get outboxSize(): number {
    return this.outbox.length;
  }

  /** Reapplies authoritative state and replays samples the server hasn't processed yet. */
  reconcile(server: { x: number; y: number; z: number; vx: number; vy: number; vz: number; ack: number }, dt: number, speedFactor: number): void {
    const before = { ...this.motor.state };
    while (this.pending.length > 0 && this.pending[0]!.seq <= server.ack) this.pending.shift();
    this.motor.reset({ x: server.x, y: server.y, z: server.z, vx: server.vx, vy: server.vy, vz: server.vz, grounded: true });
    for (const s of this.pending) this.motor.step(s, dt, speedFactor);
    const after = this.motor.state;
    const ex = before.x - after.x;
    const ey = before.y - after.y;
    const ez = before.z - after.z;
    const err = Math.hypot(ex, ey, ez);
    if (err > 0.5) {
      // Teleport-sized disagreement (respawn, restore, server placement): accept it outright.
      // Normal prediction error is millimetres; smoothing half a metre would only lag the view.
      this.offset.x = this.offset.y = this.offset.z = 0;
    } else if (err > 0.0005) {
      this.offset.x += ex;
      this.offset.y += ey;
      this.offset.z += ez;
      this.lastCorrection = err;
    }
  }

  /** Hard reset (join, reconnect, server teleport). */
  snapTo(p: V3): void {
    this.pending.length = 0;
    this.outbox.length = 0;
    this.motor.reset({ x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, grounded: true });
    this.offset.x = this.offset.y = this.offset.z = 0;
  }

  /** Discards unsent motion (backgrounding, pause, disconnect). */
  clearOutbox(): void {
    this.outbox.length = 0;
  }

  decayOffset(dt: number): void {
    const k = Math.exp(-dt * 12);
    this.offset.x *= k;
    this.offset.y *= k;
    this.offset.z *= k;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  dispose(): void {
    this.motor.dispose();
    this.pw.dispose();
  }
}
